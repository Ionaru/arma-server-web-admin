// Frontend smoke run: starts the real app against a throw-away config and data directory, drives it
// with headless Chromium like a user, and fails on any console error, page error, HTTP error from
// the app or failed script, stylesheet or font request. Nothing under the repo is touched.
//
//   node smoke/run.js
//
// Environment: SMOKE_SCREENSHOTS=<dir> saves PNGs, SMOKE_KEEP=1 keeps the temp directory.
/* global window, document, getComputedStyle, MutationObserver -- used inside page.evaluate callbacks, which run in the browser */
var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');

var playwright = require('@playwright/test');

var repoRoot = path.resolve(__dirname, '..');

// An open modal: Bootstrap 5 marks it .show, Bootstrap 3 .in (the smoke checks also run against the old tree).
var MODAL_OPEN = ':is(.modal.show, .modal.in)';
// The navbar toggler: .navbar-toggler in Bootstrap 5, .navbar-toggle in Bootstrap 3.
var NAV_TOGGLER = '#navigation :is(.navbar-toggle, .navbar-toggler)';
// The active links of the navbar: <li class="active"><a> in Bootstrap 3, a.nav-link.active in Bootstrap 5.
var NAV_ACTIVE = '#navigation .navbar-nav > li.active > a, #navigation .navbar-nav a.nav-link.active';

var WAIT_TIMEOUT = 15 * 1000;
var FIRST_LOAD_TIMEOUT = 60 * 1000;
var HOME_READY_DEADLINE = 60 * 1000;
var BUNDLE_READY_DEADLINE = 180 * 1000;
var KILL_GRACE = 5 * 1000;
var OVERALL_LIMIT = 5 * 60 * 1000;

var DESKTOP = {width: 1280, height: 900};
var NARROW = {width: 375, height: 812};

var SERVER_TABS = ['info', 'mods', 'missions', 'players', 'settings'];

var failures = [];
var currentCheck = 'setup';
var requests = [];

var root = null;
var child = null;
var childExited = false;
var browser = null;
var cleanupPromise = null;
var screenshotDir = process.env.SMOKE_SCREENSHOTS || '';

var fail = function (check, detail) {
    failures.push('FAIL ' + check + ': ' + detail);
};

var sleep = function (ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
};

var findFreePort = function () {
    return new Promise(function (resolve, reject) {
        var server = net.createServer();

        server.on('error', reject);
        server.listen(0, '127.0.0.1', function () {
            var port = server.address().port;

            server.close(function () {
                resolve(port);
            });
        });
    });
};

// Every field Server.prototype.update reads, so loading and rendering log no error. The checks that
// create a server through the API send the same shape.
var serverFixture = function (title) {
    return {
        additionalConfigurationOptions: '',
        admin_password: '',
        allowed_file_patching: 1,
        auto_start: false,
        battle_eye: false,
        file_patching: false,
        forcedDifficulty: '',
        max_players: 32,
        missions: [],
        mods: [],
        motd: '',
        number_of_headless_clients: 0,
        parameters: [],
        password: '',
        persistent: false,
        port: 2302,
        title: title,
        von: false,
        verify_signatures: false
    };
};

var createEnvironment = async function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'arma-smoke-'));

    var arma = path.join(root, 'arma');
    var work = path.join(root, 'work');

    fs.mkdirSync(path.join(arma, 'mpmissions'), {recursive: true});
    fs.mkdirSync(path.join(arma, '@smoke_mod'), {recursive: true});
    fs.mkdirSync(path.join(arma, 'logs'), {recursive: true});
    fs.mkdirSync(work, {recursive: true});

    fs.writeFileSync(path.join(arma, 'mpmissions', 'smoke.Altis.pbo'), 'smoke');
    fs.writeFileSync(path.join(arma, 'logs', 'arma3server_smoke.log'), 'smoke log\n');

    var port = await findFreePort();

    // The example file has a non-.js extension; Node loads an unknown extension as JavaScript.
    var example = require(path.join(repoRoot, 'config.js.example'));
    var config = Object.assign({}, example, {
        path: arma,
        host: '127.0.0.1',
        port: port,
        type: 'linux',
        auth: {username: '', password: ''},
        discord: {token: '', channelId: ''}
    });

    var configPath = path.join(root, 'config.js');
    fs.writeFileSync(configPath, 'module.exports = ' + JSON.stringify(config, null, 2) + ';\n');

    var servers = [serverFixture('Smoke Server')];

    fs.writeFileSync(path.join(work, 'servers.json'), JSON.stringify(servers, null, 2));
    fs.writeFileSync(path.join(work, 'op-mode.json'), JSON.stringify({
        enabled: false,
        days: [],
        time: '19:30',
        opServerId: null,
        opServerTitle: null
    }));

    return {work: work, configPath: configPath, port: port, appLog: path.join(root, 'app.log')};
};

var tailLog = function (appLog) {
    try {
        return fs.readFileSync(appLog, 'utf8').split('\n').slice(-40).join('\n');
    } catch (e) {
        return '(no app.log: ' + e.message + ')';
    }
};

var startApp = function (env) {
    var logFd = fs.openSync(env.appLog, 'a');

    child = childProcess.spawn(process.execPath, [
        '--require', path.join(repoRoot, 'smoke', 'config-shim.js'),
        path.join(repoRoot, 'app.js')
    ], {
        cwd: env.work,
        env: Object.assign({}, process.env, {SMOKE_CONFIG: env.configPath}),
        stdio: ['ignore', logFd, logFd]
    });

    fs.closeSync(logFd);

    child.on('exit', function () {
        childExited = true;
    });
};

// Resolves with the status code, or null when the request errored or timed out.
var httpStatus = function (url, timeout) {
    return new Promise(function (resolve) {
        var req = http.get(url, function (res) {
            res.resume();
            res.on('end', function () {
                resolve(res.statusCode);
            });
            res.on('error', function () {
                resolve(null);
            });
        });

        req.setTimeout(timeout, function () {
            req.destroy();
            resolve(null);
        });
        req.on('error', function () {
            resolve(null);
        });
    });
};

var waitForStatus200 = async function (url, deadline, label, env) {
    var end = Date.now() + deadline;

    while (Date.now() < end) {
        if (childExited) {
            throw new Error('the app exited before ' + label + ' was ready\n' + tailLog(env.appLog));
        }

        var status = await httpStatus(url, Math.max(1000, end - Date.now()));

        if (status === 200) {
            return;
        }

        await sleep(250);
    }

    throw new Error('timed out after ' + (deadline / 1000) + ' s waiting for ' + label + '\n' + tailLog(env.appLog));
};

var attachListeners = function (page, origin) {
    page.on('console', function (message) {
        if (message.type() !== 'error') {
            return;
        }

        var location = message.location();
        fail(currentCheck, 'console error: ' + message.text() + ' (' + location.url + ':' + location.lineNumber + ')');
    });

    page.on('pageerror', function (error) {
        fail(currentCheck, 'page error: ' + (error && error.message ? error.message : error));
    });

    page.on('response', function (response) {
        if (response.url().indexOf(origin + '/') === 0 && response.status() >= 400) {
            fail(currentCheck, 'HTTP ' + response.status() + ': ' + response.request().method() + ' ' + response.url());
        }
    });

    page.on('requestfailed', function (request) {
        var type = request.resourceType();

        if (type !== 'script' && type !== 'stylesheet' && type !== 'font') {
            return;
        }

        var failure = request.failure();
        var errorText = failure ? failure.errorText : 'unknown';

        if (errorText === 'net::ERR_ABORTED') {
            return;
        }

        fail(currentCheck, 'request failed: ' + request.method() + ' ' + request.url() + ' (' + errorText + ')');
    });

    page.on('request', function (request) {
        requests.push({method: request.method(), url: request.url(), type: request.resourceType(), postData: request.postData()});
    });
};

var screenshot = async function (page, name, suffix) {
    if (!screenshotDir) {
        return;
    }

    await page.screenshot({path: path.join(screenshotDir, name + '-' + (suffix || 'desktop') + '.png'), fullPage: true});
};

// The six page states that are also captured at a narrow width. Not asserted on.
var screenshotBoth = async function (page, name) {
    if (!screenshotDir) {
        return;
    }

    await screenshot(page, name);
    await page.setViewportSize(NARROW);

    try {
        await screenshot(page, name, 'narrow');
    } finally {
        await page.setViewportSize(DESKTOP);
    }
};

// Lets the CSS transition of a modal or dialog finish before it is photographed.
var settle = async function (page) {
    if (screenshotDir) {
        await page.waitForTimeout(500);
    }
};

var rowWithText = function (page, text) {
    return page.locator('#content table tbody tr').filter({hasText: text}).first();
};

// Clicks a navbar link and waits until the router has replaced the server view. Its Mods and
// Missions tabs list the same fixtures as the Mods and Missions pages, so without this a row left
// over from that view could satisfy the next page's marker.
var clickNav = async function (page, selector, hash) {
    await page.locator('#navigation ' + selector).click({timeout: WAIT_TIMEOUT});
    try {
        await page.waitForFunction(function (expected) {
            return window.location.hash === expected && !document.querySelector('#content #tab-info');
        }, hash, {timeout: WAIT_TIMEOUT});
    } catch (err) {
        var actual = await page.evaluate(function () { return window.location.hash; });
        throw new Error('clicking ' + selector + ' did not navigate to ' + hash + ' (hash is "' + actual + '")', {cause: err});
    }
};

// Polls a locator's count until `matches(count)` is true. Resolves with the count; throws with
// `label` and the last count seen on timeout.
var waitForCount = async function (locator, matches, label) {
    var end = Date.now() + WAIT_TIMEOUT;
    var count = await locator.count();

    while (!matches(count)) {
        if (Date.now() > end) {
            throw new Error(label + ' (found ' + count + ')');
        }

        await sleep(100);
        count = await locator.count();
    }

    return count;
};

// Goes to the dashboard and opens the smoke server's page through its link, so the server view is
// always a fresh one wherever the previous check left the page.
var openServer = async function (page, state) {
    if (!state.serverHref) {
        throw new Error('no server link was found by the home check');
    }

    await page.locator('#navigation a#dashboard').click({timeout: WAIT_TIMEOUT});

    var link = page.locator('#content a[href="' + state.serverHref + '"]');
    await link.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await link.click({timeout: WAIT_TIMEOUT});
    await page.locator('#content h2').filter({hasText: 'Smoke Server'}).waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
};

var openTab = async function (page, tab) {
    await page.locator('ul.nav-tabs a[href="#tab-' + tab + '"]').click({timeout: WAIT_TIMEOUT});
    await page.locator('#tab-' + tab).waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
};

// Every request the page made to POST /api/servers (a saved new server), oldest first.
var serverPosts = function () {
    return requests.filter(function (request) {
        return request.method === 'POST' && /\/api\/servers\/?(\?.*)?$/.test(request.url);
    });
};

// Class tokens of these Bootstrap families that no loaded stylesheet defines render unstyled and
// silently (a leftover Bootstrap 3 name, a typo). No allowlist on purpose: fix the markup instead.
var BOOTSTRAP_CLASS_FAMILY = '^(btn|label|badge|panel|card|glyphicon|bi|navbar|nav|col|offset|order|form|table|alert|text|float|pull|help|control|checkbox|radio|dropdown|modal|tab|bg|visually)(-|$)';

// Scans the navbar, the content, every open modal and every open sweetalert2 dialog.
var assertNoDeadClasses = async function (page, where) {
    var dead = await page.evaluate(function (source) {
        var family = new RegExp(source);
        var defined = new Set();
        var collect = function (rules) {
            Array.prototype.forEach.call(rules, function (rule) {
                if (rule.selectorText) {
                    (rule.selectorText.match(/\.(-?[_a-zA-Z][\w-]*)/g) || []).forEach(function (token) {
                        defined.add(token.slice(1));
                    });
                }

                if (rule.cssRules) {
                    collect(rule.cssRules);
                }
            });
        };

        Array.prototype.forEach.call(document.styleSheets, function (sheet) {
            var rules;

            try {
                rules = sheet.cssRules;
            } catch (e) {
                return;
            }

            collect(rules);
        });

        var describe = function (element) {
            return element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') +
                (element.classList.length ? '.' + Array.prototype.join.call(element.classList, '.') : '');
        };
        var found = {};
        var elements = document.querySelectorAll('#navigation, #navigation *, #content *, .modal, .modal *, .swal2-container, .swal2-container *');

        Array.prototype.forEach.call(elements, function (element) {
            Array.prototype.forEach.call(element.classList, function (token) {
                if (family.test(token) && !defined.has(token) && !found[token]) {
                    found[token] = describe(element);
                }
            });
        });

        return Object.keys(found).map(function (token) {
            return {token: token, element: found[token]};
        });
    }, BOOTSTRAP_CLASS_FAMILY);

    if (dead.length > 0) {
        throw new Error(where + ': ' + dead.length + ' class(es) defined by no loaded stylesheet: ' + dead.map(function (item) {
            return '"' + item.token + '" (first on ' + item.element + ')';
        }).join(', '));
    }
};

// Polls until the locator's visibility is `wanted`; the message says what was expected and found.
var waitForVisibility = async function (locator, wanted, label) {
    var end = Date.now() + WAIT_TIMEOUT;
    var visible = await locator.isVisible();

    while (visible !== wanted) {
        if (Date.now() > end) {
            throw new Error(label + ': expected ' + (wanted ? 'visible' : 'hidden') + ', found ' + (visible ? 'visible' : 'hidden'));
        }

        await sleep(100);
        visible = await locator.isVisible();
    }
};

// Waits until document.activeElement is inside an element matching `selector`.
var waitForFocusWithin = async function (page, selector, label, timeout) {
    try {
        await page.waitForFunction(function (sel) {
            var active = document.activeElement;

            return !!active && active.closest(sel) !== null;
        }, selector, {timeout: timeout || WAIT_TIMEOUT});
    } catch (err) {
        var active = await page.evaluate(function () {
            var element = document.activeElement;

            return element ? element.tagName.toLowerCase() + (element.className ? '.' + String(element.className).replace(/\s+/g, '.') : '') : 'nothing';
        });

        throw new Error(label + ': focus is on ' + active + ', expected it inside ' + selector, {cause: err});
    }
};

// The state a closed modal must leave behind: no .modal, no backdrop, no scroll lock on the body.
var assertModalGone = async function (page, label) {
    await waitForCount(page.locator('.modal'), function (count) { return count === 0; }, label + ': expected 0 .modal element(s)');
    await waitForCount(page.locator('.modal-backdrop'), function (count) { return count === 0; }, label + ': expected 0 .modal-backdrop element(s)');

    var body = await page.evaluate(function () {
        return {
            open: document.body.classList.contains('modal-open'),
            overflow: document.body.style.overflow,
            paddingRight: document.body.style.paddingRight
        };
    });
    var problems = [];

    if (body.open) {
        problems.push('body still has the modal-open class');
    }

    if (body.overflow !== '') {
        problems.push('body.style.overflow is "' + body.overflow + '", expected empty');
    }

    if (body.paddingRight !== '') {
        problems.push('body.style.paddingRight is "' + body.paddingRight + '", expected empty');
    }

    if (problems.length > 0) {
        throw new Error(label + ': ' + problems.join('; '));
    }
};

// An open modal is the only .modal, shown, with one backdrop, the body locked and the focus inside it.
var assertModalOpen = async function (page, label) {
    await waitForCount(page.locator(MODAL_OPEN), function (count) { return count === 1; }, label + ': expected exactly 1 .modal.show element');

    var counts = await page.evaluate(function () {
        return {
            modals: document.querySelectorAll('.modal').length,
            backdrops: document.querySelectorAll('.modal-backdrop').length,
            open: document.body.classList.contains('modal-open')
        };
    });

    if (counts.modals !== 1 || counts.backdrops !== 1 || !counts.open) {
        throw new Error(label + ': found ' + counts.modals + ' .modal, ' + counts.backdrops + ' .modal-backdrop and body.modal-open ' +
            counts.open + ', expected 1, 1 and true');
    }

    await waitForFocusWithin(page, '.modal', label);
};

// Opens the Add server modal from the dashboard's button.
var openAddServer = async function (page) {
    await page.locator('#navigation a#dashboard').click({timeout: WAIT_TIMEOUT});
    await page.locator('#content a.btn-primary#add-server').click({timeout: WAIT_TIMEOUT});
    await page.locator(MODAL_OPEN + ' input.title').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
};

// sweetalert2 renders unstyled buttons (buttonsStyling is off): Bootstrap classes must give both a
// background and a border, the app css a gap between them, and the popup the 16px root font size.
var assertSwalLooksRight = async function (page, label) {
    var info = await page.evaluate(function () {
        var popup = document.querySelector('.swal2-popup');
        var buttons = Array.prototype.map.call(document.querySelectorAll('.swal2-actions .btn'), function (button) {
            var style = getComputedStyle(button);
            var rect = button.getBoundingClientRect();

            return {
                text: button.textContent.trim(),
                background: style.backgroundColor,
                borderWidth: style.borderTopWidth,
                borderStyle: style.borderTopStyle,
                left: rect.left,
                right: rect.right
            };
        });

        buttons.sort(function (a, b) { return a.left - b.left; });

        return {fontSize: popup ? getComputedStyle(popup).fontSize : 'no popup', buttons: buttons};
    });
    var problems = [];

    if (info.fontSize !== '16px') {
        problems.push('popup font-size is ' + info.fontSize + ', expected 16px');
    }

    if (info.buttons.length !== 2) {
        problems.push('found ' + info.buttons.length + ' .swal2-actions .btn button(s), expected 2');
    }

    info.buttons.forEach(function (button) {
        if (button.background === 'rgba(0, 0, 0, 0)' || button.background === 'transparent') {
            problems.push('the "' + button.text + '" button has a transparent background');
        }

        if (button.borderStyle === 'none' || button.borderWidth === '0px') {
            problems.push('the "' + button.text + '" button has no border (' + button.borderStyle + ' ' + button.borderWidth + ')');
        }
    });

    if (info.buttons.length === 2 && !(info.buttons[1].left - info.buttons[0].right > 0)) {
        problems.push('the gap between the two buttons is ' + (info.buttons[1].left - info.buttons[0].right) + 'px, expected more than 0');
    }

    if (problems.length > 0) {
        throw new Error(label + ': ' + problems.join('; '));
    }
};

// Types into a filter input (the handlers listen to keyup, which fill() alone does not fire) and
// checks the table narrows without the input being re-rendered: it must keep its value.
var assertFilter = async function (page, label, inputSelector, rowsSelector) {
    var input = page.locator(inputSelector);
    var rows = page.locator(rowsSelector);

    await input.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await rows.first().waitFor({state: 'attached', timeout: WAIT_TIMEOUT});

    var total = await rows.count();

    if (total < 1) {
        throw new Error(label + ': expected at least 1 row before filtering');
    }

    var expectValue = async function (step, expected) {
        var actual = await input.inputValue({timeout: WAIT_TIMEOUT});

        if (actual !== expected) {
            throw new Error(label + ': after ' + step + ' the filter input holds "' + actual + '", expected "' + expected + '"');
        }
    };

    var clear = async function () {
        await input.fill('');
        await input.press('End');
    };

    await input.pressSequentially('zzz-no-match');
    await waitForCount(rows, function (count) { return count === 0; }, label + ': typing zzz-no-match did not empty the list');
    await expectValue('typing zzz-no-match', 'zzz-no-match');

    await clear();
    await waitForCount(rows, function (count) { return count === total; }, label + ': clearing the filter did not bring back ' + total + ' row(s)');
    await expectValue('clearing the filter', '');

    await input.pressSequentially('SMOKE');
    await waitForCount(rows, function (count) { return count >= 1; }, label + ': typing SMOKE left no row');

    var end = Date.now() + WAIT_TIMEOUT;
    var texts = await rows.allTextContents();

    while (!texts.every(function (text) { return text.toLowerCase().indexOf('smoke') !== -1; })) {
        if (Date.now() > end) {
            throw new Error(label + ': after typing SMOKE a row does not contain "smoke": ' + JSON.stringify(texts));
        }

        await sleep(100);
        texts = await rows.allTextContents();
    }

    await expectValue('typing SMOKE', 'SMOKE');

    // Leave the page as found: empty filter, nothing focused.
    await clear();
    await waitForCount(rows, function (count) { return count === total; }, label + ': clearing the filter again did not bring back ' + total + ' row(s)');
    await input.evaluate(function (element) { element.blur(); });
};

// A check that fails halfway can leave a modal (and its backdrop and scroll lock) behind, which would
// make every later check time out. Whatever it was, the page is reloaded clean afterwards.
var clearLeftoverModals = async function (page) {
    try {
        if (await page.locator('.modal, .modal-backdrop, .swal2-container').count() === 0) {
            return;
        }

        await page.reload({timeout: FIRST_LOAD_TIMEOUT});
        await page.locator('#navigation .navbar').waitFor({state: 'visible', timeout: FIRST_LOAD_TIMEOUT});
    } catch (e) {
        // The failure of the check itself is the one that matters.
    }
};

var withModalCleanup = function (run) {
    return async function (page, state) {
        try {
            return await run(page, state);
        } finally {
            await clearLeftoverModals(page);
        }
    };
};

var checks = [];

checks.push({name: 'home', run: async function (page, state) {
    await page.goto(state.origin + '/', {timeout: FIRST_LOAD_TIMEOUT});
    await page.locator('#navigation .navbar').waitFor({state: 'visible', timeout: FIRST_LOAD_TIMEOUT});

    var rows = page.locator('#content table tbody tr');
    await rows.first().waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var count = await rows.count();

    if (count !== 1) {
        throw new Error('expected exactly 1 server row, found ' + count);
    }

    var link = rows.first().locator('a[href^="#servers/"]');
    var text = await link.textContent({timeout: WAIT_TIMEOUT});

    if (text.indexOf('Smoke Server') === -1) {
        throw new Error('server row link text is "' + text + '"');
    }

    // The id is read from the link, never computed from the title.
    var href = await link.getAttribute('href');
    state.serverHref = href;

    // Icons are the bootstrap-icons webfont: a glyph in ::before of every .bi element.
    await page.locator('#content .bi').first().waitFor({state: 'attached', timeout: WAIT_TIMEOUT});

    try {
        await page.waitForFunction(async function () {
            await document.fonts.ready;

            var loaded = false;
            document.fonts.forEach(function (font) {
                if (font.family.replace(/["']/g, '') === 'bootstrap-icons' && font.status === 'loaded') {
                    loaded = true;
                }
            });

            return loaded;
        }, null, {timeout: WAIT_TIMEOUT});
    } catch (err) {
        throw new Error('no loaded FontFace with the family bootstrap-icons', {cause: err});
    }

    var icons = await page.evaluate(function () {
        var elements = document.querySelectorAll('#content .bi');
        var bad = [];

        Array.prototype.forEach.call(elements, function (element) {
            var before = getComputedStyle(element, '::before');
            var rect = element.getBoundingClientRect();
            var content = before.content.replace(/^["']|["']$/g, '');
            var problems = [];

            if (before.fontFamily.indexOf('bootstrap-icons') === -1) {
                problems.push('::before font-family is ' + before.fontFamily);
            }

            if (before.content === 'none' || before.content === 'normal' || content === '') {
                problems.push('::before content is ' + before.content);
            }

            if (!(rect.width > 0 && rect.height > 0)) {
                problems.push('size is ' + rect.width + 'x' + rect.height);
            }

            if (problems.length > 0) {
                bad.push('.' + Array.prototype.join.call(element.classList, '.') + ': ' + problems.join(', '));
            }
        });

        return {total: elements.length, bad: bad};
    });

    if (icons.bad.length > 0) {
        throw new Error(icons.bad.length + ' of ' + icons.total + ' #content .bi icon(s) do not render a glyph, first ' + icons.bad[0]);
    }

    var glyphicons = requests.filter(function (request) {
        return /glyphicons/i.test(request.url);
    });

    if (glyphicons.length > 0) {
        throw new Error('the page still requested a Glyphicons file: ' + glyphicons[0].url);
    }

    // The emitted file name is a content hash, so the family check above is what names the font.
    if (!requests.some(function (request) { return request.url.indexOf('.woff2') !== -1; })) {
        throw new Error('no request URL contains .woff2, expected the bootstrap-icons font');
    }

    await assertNoDeadClasses(page, 'the dashboard');

    await screenshotBoth(page, 'home');
}});

checks.push({name: 'server', run: async function (page, state) {
    if (!state.serverHref) {
        throw new Error('no server link was found by the home check');
    }

    await page.locator('#content a[href="' + state.serverHref + '"]').click({timeout: WAIT_TIMEOUT});
    await page.locator('#content h2').filter({hasText: 'Smoke Server'}).waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    for (var i = 0; i < SERVER_TABS.length; i++) {
        var tab = SERVER_TABS[i];

        await page.locator('ul.nav-tabs a[href="#tab-' + tab + '"]').click({timeout: WAIT_TIMEOUT});

        var pane = page.locator('#tab-' + tab);
        await pane.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

        var className = await pane.getAttribute('class');

        if (className.split(/\s+/).indexOf('active') === -1) {
            throw new Error('#tab-' + tab + ' is visible but has no active class ("' + className + '")');
        }

        if (tab === 'info') {
            await screenshotBoth(page, 'server-info');
        } else {
            await screenshot(page, 'server-' + tab);
        }
    }
}});


// B2: the navbar Servers dropdown lists the servers and marks the open one.
checks.push({name: 'server dropdown', run: async function (page, state) {
    await openServer(page, state);

    var items = page.locator('#servers-list > li');
    await items.first().waitFor({state: 'attached', timeout: WAIT_TIMEOUT});

    var count = await items.count();

    if (count !== 1) {
        throw new Error('expected 1 item in the servers dropdown, found ' + count);
    }

    var text = (await items.first().locator('a').textContent({timeout: WAIT_TIMEOUT})).trim();

    if (text !== 'Smoke Server') {
        throw new Error('the servers dropdown item text is "' + text + '"');
    }

    var active = page.locator('#servers-list > li.active > a, #servers-list > li > a.dropdown-item.active');
    await active.waitFor({state: 'attached', timeout: WAIT_TIMEOUT});

    var href = await active.getAttribute('href');

    if (href !== state.serverHref) {
        throw new Error('the active dropdown item links to "' + href + '", expected "' + state.serverHref + '"');
    }
}});

// B5: every region of the server page renders its content.
checks.push({name: 'server regions', run: async function (page, state) {
    await openServer(page, state);

    await openTab(page, 'info');

    var info = page.locator('#tab-info');
    var infoText = await info.innerText({timeout: WAIT_TIMEOUT});

    if (infoText.indexOf('Offline') === -1) {
        throw new Error('the Info tab does not show Offline: ' + JSON.stringify(infoText));
    }

    await info.locator('a#start').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoDeadClasses(page, 'the server Info tab');

    await openTab(page, 'mods');

    var modRow = page.locator('#tab-mods tbody tr').filter({hasText: '@smoke_mod'});
    await modRow.first().waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    if (await modRow.first().locator('input[type=checkbox]').isChecked({timeout: WAIT_TIMEOUT})) {
        throw new Error('the checkbox of @smoke_mod is checked, the server has no mods');
    }

    await assertNoDeadClasses(page, 'the server Mods tab');

    await openTab(page, 'missions');
    await page.locator('#tab-missions #available tbody tr').filter({hasText: 'smoke'}).first()
        .waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await page.locator('#tab-missions #rotation a.add-mission').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoDeadClasses(page, 'the server Missions tab');

    await openTab(page, 'players');

    var playersText = await page.locator('#tab-players').innerText({timeout: WAIT_TIMEOUT});

    if (playersText.indexOf('Server not online') === -1) {
        throw new Error('the Players tab does not show "Server not online": ' + JSON.stringify(playersText));
    }

    await assertNoDeadClasses(page, 'the server Players tab');

    await openTab(page, 'settings');

    var title = await page.locator('#tab-settings #settings input.title').inputValue({timeout: WAIT_TIMEOUT});

    if (title !== 'Smoke Server') {
        throw new Error('the Settings tab title input holds "' + title + '"');
    }

    await page.locator('#tab-settings #parameters a.add-parameter').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoDeadClasses(page, 'the server Settings tab');
}});

// B4: the filter on the server Missions tab narrows the available missions.
checks.push({name: 'server missions filter', run: async function (page, state) {
    await openServer(page, state);
    await openTab(page, 'missions');
    await assertFilter(page, 'server missions filter', '#tab-missions #filterMissions', '#tab-missions #available tbody tr');
}});

checks.push({name: 'missions', run: async function (page) {
    await clickNav(page, 'a#missions', '#missions');
    await rowWithText(page, 'smoke').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoDeadClasses(page, 'the Missions page');
    await screenshotBoth(page, 'missions');
}});

// B3: the filter on the Missions page narrows the list.
checks.push({name: 'missions filter', run: async function (page) {
    await clickNav(page, 'a#missions', '#missions');
    await assertFilter(page, 'missions filter', '#content #filterMissions', '#content #list tbody tr');
}});

// Uploads through the real form (FormData over XHR). The file input is named `missions` and shares
// its id with the navbar link, so it is addressed through its panel. The mission list refreshes via
// the socket `missions` event, not through the upload view.
var uploadPosts = function () {
    return requests.filter(function (request) {
        return request.method === 'POST' && request.url.indexOf('/api/missions') !== -1;
    }).length;
};

var uploadAndExpect = async function (page, label, names, hrefs, delayMs) {
    var uploadDir = fs.mkdtempSync(path.join(root, 'upload-'));
    var files = names.map(function (name) {
        var file = path.join(uploadDir, name);

        fs.writeFileSync(file, 'SMOKE-UPLOAD');
        return file;
    });
    var input = page.locator('#upload input[type=file]');
    var button = page.locator('#upload button[type=submit]');

    await input.waitFor({state: 'attached', timeout: WAIT_TIMEOUT});
    await page.evaluate(function () { window.__smokeUploadMarker = 'still-here'; });
    await input.setInputFiles(files);

    var delayRoute = null;

    if (delayMs) {
        // Hold the POST so the button's pending state can be observed, then pass it on to the real server.
        delayRoute = async function (route) {
            if (route.request().method() === 'POST') {
                await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
            }

            await route.continue();
        };
        await page.route('**/api/missions', delayRoute);
    }

    await button.click({timeout: WAIT_TIMEOUT});

    if (delayMs) {
        try {
            // B8: Ladda marks the button while the request is pending.
            await page.waitForFunction(function () {
                var btn = document.querySelector('#upload button[type=submit]');

                return btn && btn.hasAttribute('data-loading');
            }, null, {timeout: delayMs - 500});
        } catch (err) {
            throw new Error(label + ': the Upload button had no data-loading attribute while the upload was pending', {cause: err});
        }
    }

    for (var i = 0; i < hrefs.length; i++) {
        await page.locator('#content table tbody a[href="' + hrefs[i] + '"]').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    }

    var marker = await page.evaluate(function () { return window.__smokeUploadMarker; });

    if (marker !== 'still-here' || await page.evaluate(function () { return window.location.hash; }) !== '#missions') {
        throw new Error(label + ': the page navigated or reloaded during the upload');
    }

    try {
        await page.waitForFunction(function () {
            var btn = document.querySelector('#upload button[type=submit]');
            var file = document.querySelector('#upload input[type=file]');

            return btn && file && !btn.hasAttribute('disabled') && !btn.hasAttribute('data-loading') && file.files.length === 0;
        }, null, {timeout: WAIT_TIMEOUT});
    } catch (err) {
        throw new Error(label + ': the Upload button did not become enabled again or the file input was not emptied', {cause: err});
    } finally {
        if (delayRoute) {
            await page.unroute('**/api/missions', delayRoute);
        }
    }
};

checks.push({name: 'mission upload', run: async function (page) {
    await clickNav(page, 'a#missions', '#missions');
    await rowWithText(page, 'smoke').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    await uploadAndExpect(page, 'single upload', ['Upload_One.Altis.pbo'], ['/api/missions/upload_one.altis.pbo']);
    await uploadAndExpect(page, 'several files', ['Upload_A.Altis.pbo', 'Upload_B.Stratis.pbo'], [
        '/api/missions/upload_a.altis.pbo',
        '/api/missions/upload_b.stratis.pbo'
    ]);
    await screenshot(page, 'missions-upload');

    // B8: a delayed POST keeps the button in the Ladda loading state until the response arrives.
    await uploadAndExpect(page, 'delayed upload', ['Upload_Slow.Altis.pbo'], ['/api/missions/upload_slow.altis.pbo'], 1500);

    // Nothing selected: no request and the button stays usable.
    var before = uploadPosts();
    var allBefore = requests.length;

    await page.evaluate(function () { window.__smokeUploadMarker = 'still-here'; });
    await page.locator('#upload button[type=submit]').click({timeout: WAIT_TIMEOUT});
    await page.waitForTimeout(1000);

    var sent = requests.slice(allBefore).filter(function (request) {
        return request.url.indexOf('/api/missions') !== -1;
    });

    if (sent.length !== 0 || uploadPosts() !== before) {
        throw new Error('clicking Upload with no file selected sent ' + sent.length + ' request(s) to /api/missions');
    }

    var state = await page.evaluate(function () {
        var btn = document.querySelector('#upload button[type=submit]');

        return {
            disabled: btn.hasAttribute('disabled'),
            loading: btn.hasAttribute('data-loading'),
            marker: window.__smokeUploadMarker,
            hash: window.location.hash
        };
    });

    if (state.disabled || state.loading) {
        throw new Error('the Upload button is not enabled after clicking with no file selected');
    }

    if (state.marker !== 'still-here' || state.hash !== '#missions') {
        throw new Error('the page navigated or reloaded when Upload was clicked with no file selected');
    }
}});

// B3: leaving the Missions page while an upload runs must not make the success callback render a
// destroyed view (ViewDestroyedError). The page-error listener fails this check if it does.
checks.push({name: 'mission upload then navigate away', run: async function (page) {
    await clickNav(page, 'a#missions', '#missions');

    var uploadDir = fs.mkdtempSync(path.join(root, 'upload-'));
    var file = path.join(uploadDir, 'Upload_Nav.Altis.pbo');

    fs.writeFileSync(file, 'SMOKE-UPLOAD');

    var input = page.locator('#upload input[type=file]');

    await input.waitFor({state: 'attached', timeout: WAIT_TIMEOUT});
    await input.setInputFiles([file]);

    var delayRoute = async function (route) {
        if (route.request().method() === 'POST') {
            await new Promise(function (resolve) { setTimeout(resolve, 1500); });
        }

        await route.continue();
    };

    await page.route('**/api/missions', delayRoute);

    try {
        var answered = page.waitForResponse(function (response) {
            return response.request().method() === 'POST' && response.url().indexOf('/api/missions') !== -1;
        }, {timeout: WAIT_TIMEOUT});

        await page.locator('#upload button[type=submit]').click({timeout: WAIT_TIMEOUT});
        await clickNav(page, 'a#mods', '#mods');
        await answered;

        // Give the success callback time to run (and to throw, if it renders the destroyed view).
        await page.waitForTimeout(1000);
    } finally {
        await page.unroute('**/api/missions', delayRoute);
    }
}});

checks.push({name: 'mods', run: async function (page) {
    await clickNav(page, 'a#mods', '#mods');
    await rowWithText(page, '@smoke_mod').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoDeadClasses(page, 'the Mods page');
    await screenshotBoth(page, 'mods');
}});

checks.push({name: 'logs', run: withModalCleanup(async function (page) {
    await clickNav(page, 'a#logs', '#logs');
    await rowWithText(page, 'arma3server_smoke.log').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoDeadClasses(page, 'the Logs page');
    await screenshotBoth(page, 'logs');

    // B7: the delete confirm is cancelled, so nothing is deleted.
    var deletes = function () {
        return requests.filter(function (request) {
            return request.method === 'DELETE' && request.url.indexOf('/api/logs/') !== -1;
        }).length;
    };
    var deletesBefore = deletes();
    var row = rowWithText(page, 'arma3server_smoke.log');

    await row.locator('.destroy').click({timeout: WAIT_TIMEOUT});

    var popup = page.locator('.swal2-popup');
    await popup.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var confirmClass = await popup.locator('.swal2-confirm').getAttribute('class');

    if (confirmClass.split(/\s+/).indexOf('btn-danger') === -1) {
        throw new Error('the log delete confirm button has no btn-danger class ("' + confirmClass + '")');
    }

    await assertSwalLooksRight(page, 'the log delete confirm');
    await assertNoDeadClasses(page, 'the log delete confirm');
    await settle(page);
    await screenshot(page, 'logs-delete-confirm');

    await popup.locator('.swal2-cancel').click({timeout: WAIT_TIMEOUT});
    await popup.waitFor({state: 'hidden', timeout: WAIT_TIMEOUT});
    await page.waitForTimeout(1000);

    if (deletes() !== deletesBefore) {
        throw new Error('a DELETE request to /api/logs/ was sent after cancelling the delete confirm');
    }

    await rowWithText(page, 'arma3server_smoke.log').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
})});

checks.push({name: 'op-mode', run: withModalCleanup(async function (page) {
    var runPosts = function () {
        return requests.filter(function (request) {
            return request.method === 'POST' && request.url.indexOf('/api/op-mode/run') !== -1;
        }).length;
    };
    var before = runPosts();

    await page.locator('#navigation a[href="#op-mode"]').click({timeout: WAIT_TIMEOUT});
    await page.locator('#content form').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await page.locator('#content h1').filter({hasText: 'Op Mode'}).waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var run = page.locator('button.run');
    await run.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    if (!await run.isEnabled()) {
        throw new Error('the Run now button is disabled');
    }

    await assertNoDeadClasses(page, 'the Op Mode page');
    await screenshotBoth(page, 'op-mode');

    await run.click({timeout: WAIT_TIMEOUT});

    var dialog = page.locator('.swal2-popup');
    await dialog.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var cancel = dialog.locator('.swal2-cancel');
    await cancel.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    await assertSwalLooksRight(page, 'the Op Mode Run now confirm');
    await assertNoDeadClasses(page, 'the Op Mode Run now confirm');

    await settle(page);
    await screenshot(page, 'op-mode-run-confirm');

    // Never the confirm button: that would stop servers.
    await cancel.click({timeout: WAIT_TIMEOUT});
    await dialog.waitFor({state: 'hidden', timeout: WAIT_TIMEOUT});

    if (runPosts() !== before) {
        throw new Error('POST /api/op-mode/run was sent');
    }
})});

// B1: the navbar marks exactly the link of the current route as active.
var assertActiveNav = async function (page, linkSelector) {
    var read = function () {
        return page.evaluate(function (args) {
            var items = document.querySelectorAll(args.active);

            return {
                count: items.length,
                hasLink: items.length === 1 && items[0].matches(args.selector)
            };
        }, {selector: linkSelector, active: NAV_ACTIVE});
    };
    var end = Date.now() + WAIT_TIMEOUT;
    var result = await read();

    while (result.count !== 1 || !result.hasLink) {
        if (Date.now() > end) {
            throw new Error('after opening ' + linkSelector + ' the navbar has ' + result.count + ' active navbar link(s) (' + NAV_ACTIVE + ')' +
                (result.count === 1 ? ' and it is not that link' : ' (expected exactly 1, being that link)'));
        }

        await sleep(100);
        result = await read();
    }
};

checks.push({name: 'nav active tab', run: async function (page) {
    var routes = [
        ['a#missions', '#missions'],
        ['a#logs', '#logs'],
        ['a#mods', '#mods'],
        ['a[href="#op-mode"]', '#op-mode'],
        ['a#dashboard', '']
    ];

    for (var i = 0; i < routes.length; i++) {
        await clickNav(page, routes[i][0], routes[i][1]);
        await assertActiveNav(page, routes[i][0]);
    }
}});

// An unrendered template shows up as literal {{placeholder}} or <% %> text.
var assertNoTemplateMarkers = async function (modal, label) {
    var text = await modal.innerText({timeout: WAIT_TIMEOUT});
    if (/\{\{|\}\}|<%|%>|\[object Object\]/.test(text)) {
        throw new Error(label + ' shows unrendered template text: ' + JSON.stringify(text));
    }
};

// The content must start below the fixed navbar at every width, or its first row hides under it.
var assertContentBelowNavbar = async function (page, label) {
    var rects = await page.evaluate(function () {
        var navbar = document.querySelector('#navigation .navbar');
        var first = document.querySelector('#content').firstElementChild;

        return {
            navbarBottom: navbar.getBoundingClientRect().bottom,
            contentTop: first ? first.getBoundingClientRect().top : null
        };
    });

    if (rects.contentTop === null) {
        throw new Error(label + ': #content has no child element to measure');
    }

    if (rects.contentTop < rects.navbarBottom - 0.5) {
        throw new Error(label + ': the first element of #content starts at y=' + rects.contentTop + ' but the navbar ends at y=' + rects.navbarBottom);
    }
};

checks.push({name: 'navbar collapse', run: async function (page) {
    var toggler = page.locator(NAV_TOGGLER);
    var collapse = page.locator('#navigation .navbar-collapse');
    var missions = page.locator('#navigation a#missions');

    await clickNav(page, 'a#dashboard', '');

    try {
        var wide = [DESKTOP, {width: 768, height: 900}];

        for (var i = 0; i < wide.length; i++) {
            var label = 'at ' + wide[i].width + 'px';

            await page.setViewportSize(wide[i]);
            await waitForVisibility(toggler, false, label + ' the navbar toggler');
            await waitForVisibility(missions, true, label + ' the Missions link');

            var height = await page.evaluate(function () {
                return document.querySelector('#navigation .navbar').getBoundingClientRect().height;
            });

            if (height > 60) {
                throw new Error(label + ' the navbar is ' + height + 'px tall, expected at most 60px (it wrapped)');
            }

            await assertContentBelowNavbar(page, label);
        }

        await page.setViewportSize(NARROW);
        await waitForVisibility(toggler, true, 'at 375px the navbar toggler');
        await waitForVisibility(collapse, false, 'at 375px the closed .navbar-collapse');
        await waitForVisibility(missions, false, 'at 375px the Missions link in the closed menu');
        await assertContentBelowNavbar(page, 'at 375px');

        await toggler.click({timeout: WAIT_TIMEOUT});
        await waitForVisibility(collapse, true, 'at 375px the .navbar-collapse after clicking the toggler');
        await waitForVisibility(missions, true, 'at 375px the Missions link in the open menu');

        var expanded = await toggler.getAttribute('aria-expanded', {timeout: WAIT_TIMEOUT});

        if (expanded !== 'true') {
            throw new Error('the open toggler has aria-expanded="' + expanded + '", expected "true"');
        }

        await settle(page);
        await screenshot(page, 'navbar-open', 'narrow');

        await clickNav(page, 'a#missions', '#missions');

        // Choosing a link re-renders the navbar: the rebuilt menu starts collapsed.
        await waitForVisibility(collapse, false, 'at 375px the .navbar-collapse after clicking Missions (the navbar was re-rendered)');
        await waitForVisibility(missions, false, 'at 375px the Missions link after clicking Missions (the navbar was re-rendered)');
    } finally {
        await page.setViewportSize(DESKTOP);
    }
}});

// R2: choosing a link while the menu is still opening re-renders the navbar mid-transition. Bootstrap's
// pending completion timer must not throw (the global pageerror listener fails the run when it does,
// about 350 ms later). The default motion setting is needed for the transition to take time, so this
// check uses its own context like the fade check below; both clicks are dispatched in one task so nothing
// waits for the menu to open.
checks.push({name: 'navbar link clicked while the menu opens', run: async function (page, state) {
    var context = await browser.newContext({viewport: NARROW});

    try {
        var narrowPage = await context.newPage();

        attachListeners(narrowPage, state.origin);
        await narrowPage.goto(state.origin + '/', {timeout: FIRST_LOAD_TIMEOUT});
        await narrowPage.locator('#navigation .navbar').waitFor({state: 'visible', timeout: FIRST_LOAD_TIMEOUT});
        await waitForVisibility(narrowPage.locator(NAV_TOGGLER), true, 'at 375px the navbar toggler');

        await narrowPage.evaluate(function (togglerSelector) {
            document.querySelector(togglerSelector).click();
            document.querySelector('#navigation a#logs').click();
        }, NAV_TOGGLER);

        // Longer than the 350 ms of the collapse transition.
        await narrowPage.waitForTimeout(800);

        var hash = await narrowPage.evaluate(function () { return window.location.hash; });

        if (hash !== '#logs') {
            throw new Error('800 ms after clicking the toggler and a#logs the hash is "' + hash + '", expected "#logs"');
        }
    } finally {
        await context.close();
    }
}});

// At 375px the navbar's links are behind the toggler.
var openNavbarMenu = async function (page) {
    if (!await page.locator('#navigation .navbar-collapse').isVisible()) {
        await page.locator(NAV_TOGGLER).click({timeout: WAIT_TIMEOUT});
        await waitForVisibility(page.locator('#navigation .navbar-collapse'), true, 'the navbar menu after clicking the toggler');
    }
};

var openServersMenu = async function (page, narrow) {
    if (narrow) {
        await openNavbarMenu(page);
    }

    try {
        await page.locator('#navigation .dropdown-toggle').click({timeout: WAIT_TIMEOUT});
    } catch (err) {
        var found = await page.evaluate(function () {
            var toggles = document.querySelectorAll('#navigation .dropdown-toggle');
            return {
                count: toggles.length,
                visible: Array.prototype.filter.call(toggles, function (toggle) { return toggle.getClientRects().length > 0; }).length,
                width: window.innerWidth,
                hash: window.location.hash,
                collapse: document.querySelector('#navbar-collapse') ? document.querySelector('#navbar-collapse').className : 'missing',
                expanded: document.querySelector('.navbar-toggler, .navbar-toggle') ? document.querySelector('.navbar-toggler, .navbar-toggle').getAttribute('aria-expanded') : 'missing'
            };
        });
        throw new Error((narrow ? 'at 375px' : 'on the desktop') + ' clicking the Servers toggle failed: ' + found.count + ' #navigation .dropdown-toggle element(s), ' + found.visible + ' displayed, window ' + found.width + 'px wide, hash "' + found.hash + '", #navbar-collapse class "' + found.collapse + '", toggler aria-expanded "' + found.expanded + '", expected one displayed toggle', {cause: err});
    }

    await waitForVisibility(page.locator('#servers-list'), true, 'the Servers menu after clicking its toggle');
};

var assertServersMenu = async function (page, state, narrow) {
    var label = narrow ? 'at 375px' : 'on the desktop';
    var menu = page.locator('#servers-list');

    if (narrow) {
        await openNavbarMenu(page);
    }

    await clickNav(page, 'a#dashboard', '');
    await openServersMenu(page, narrow);

    // A Bootstrap loaded twice handles the click twice: the menu opens and shuts again.
    await sleep(300);

    if (!await menu.isVisible()) {
        throw new Error(label + ' the Servers menu was hidden 300 ms after opening it (is Bootstrap loaded twice?)');
    }

    if (!narrow) {
        await settle(page);
        await screenshot(page, 'dropdown-open');
    }

    var items = menu.locator('a');
    var count = await items.count();

    if (count !== 1) {
        throw new Error(label + ' the Servers menu has ' + count + ' link(s) (#servers-list a), expected 1');
    }

    // The route re-renders the navbar after the hash changes: remember the old toggle to tell the two apart.
    await page.evaluate(function () {
        window.smokeOldServersToggle = document.querySelector('#navigation .dropdown-toggle');
    });

    await items.first().click({timeout: WAIT_TIMEOUT});

    try {
        await page.waitForFunction(function (expected) {
            return window.location.hash === expected &&
                document.querySelector('#navigation .dropdown-toggle') !== window.smokeOldServersToggle;
        }, state.serverHref, {timeout: WAIT_TIMEOUT});
    } catch (err) {
        var hash = await page.evaluate(function () { return window.location.hash; });
        throw new Error(label + ' clicking the server in the Servers menu left the hash at "' + hash + '", expected "' + state.serverHref + '"', {cause: err});
    }

    await waitForVisibility(menu, false, label + ' the Servers menu after choosing a server');
    await openServersMenu(page, narrow);

    var active = menu.locator('li.active > a, a.dropdown-item.active');
    await waitForCount(active, function (found) { return found === 1; }, label + ' expected exactly 1 active link (li.active > a or a.dropdown-item.active) in the reopened Servers menu');

    var href = await active.getAttribute('href', {timeout: WAIT_TIMEOUT});

    if (href !== state.serverHref) {
        throw new Error(label + ' the active Servers menu item links to "' + href + '", expected "' + state.serverHref + '"');
    }
};

checks.push({name: 'navbar servers menu', run: async function (page, state) {
    if (!state.serverHref) {
        throw new Error('no server link was found by the home check');
    }

    await assertServersMenu(page, state, false);

    try {
        await page.setViewportSize(NARROW);
        await assertServersMenu(page, state, true);
    } finally {
        await page.setViewportSize(DESKTOP);
    }
}});

// R1: on a phone in landscape the open menu is taller than the viewport. The fixed navbar must scroll
// by itself then, or its last links cannot be reached (Playwright's click scrolls an element into view,
// which only works when something can scroll). With the fixture's single server the open menu still
// fits into 375px, so this check adds extra servers first and removes them afterwards; it runs before
// the state-changing checks, which expect the initial servers.
checks.push({name: 'navbar menu scrolls at 667x375', run: async function (page) {
    var LANDSCAPE = {width: 667, height: 375};
    var EXTRA = ['Smoke Scroll 1', 'Smoke Scroll 2', 'Smoke Scroll 3', 'Smoke Scroll 4', 'Smoke Scroll 5'];
    var links = page.locator('#servers-list a');
    var initial = await links.count();
    var added = false;

    try {
        var statuses = await page.evaluate(async function (bodies) {
            var result = [];

            for (var i = 0; i < bodies.length; i++) {
                var response = await fetch('/api/servers', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(bodies[i])
                });

                result.push(response.status);
            }

            return result;
        }, EXTRA.map(serverFixture));

        added = true;

        if (statuses.some(function (status) { return status !== 200; })) {
            throw new Error('POST /api/servers for the extra servers answered ' + JSON.stringify(statuses) + ', expected only 200');
        }

        await waitForCount(links, function (count) { return count === initial + EXTRA.length; }, 'the Servers menu did not grow to ' + (initial + EXTRA.length) + ' link(s) after adding the extra servers');

        await page.setViewportSize(LANDSCAPE);
        await openNavbarMenu(page);
        await clickNav(page, 'a#dashboard', '');
        await openServersMenu(page, true);

        var last = links.last();
        var href = await last.getAttribute('href', {timeout: WAIT_TIMEOUT});
        // Measure where the link sits when nothing is scrolled: the menu must have finished its collapse
        // transition first (Bootstrap 3 scrolls the capped collapse while it is still opening), and every
        // ancestor's scroll offset is added back, so a menu that is already scrolled does not hide the need.
        await page.waitForFunction(function () {
            var collapse = document.querySelector('#navbar-collapse');

            return !collapse || !collapse.classList.contains('collapsing');
        }, null, {timeout: WAIT_TIMEOUT});

        var unscrolledTop = await last.evaluate(function (el) {
            var y = el.getBoundingClientRect().top;

            for (var node = el.parentElement; node; node = node.parentElement) {
                y += node.scrollTop;
            }

            return y + window.scrollY;
        });
        var innerHeight = await page.evaluate(function () { return window.innerHeight; });

        if (unscrolledTop < innerHeight) {
            throw new Error('at 667x375 the last link of the Servers menu (' + href + ') starts at ' + unscrolledTop + ' when nothing is scrolled, expected it below the ' + innerHeight + 'px viewport so the check proves scrolling is needed');
        }

        try {
            await last.click({timeout: WAIT_TIMEOUT});
        } catch (err) {
            throw new Error('at 667x375 the last link of the Servers menu (' + href + ') cannot be clicked, expected the menu to scroll it into view', {cause: err});
        }

        try {
            await page.waitForFunction(function (expected) {
                return window.location.hash === expected;
            }, href, {timeout: WAIT_TIMEOUT});
        } catch (err) {
            var hash = await page.evaluate(function () { return window.location.hash; });
            throw new Error('at 667x375 clicking the last link of the Servers menu left the hash at "' + hash + '", expected "' + href + '"', {cause: err});
        }
    } finally {
        await page.setViewportSize(DESKTOP);

        if (added) {
            await page.evaluate(async function (ids) {
                for (var i = 0; i < ids.length; i++) {
                    await fetch('/api/servers/' + encodeURIComponent(ids[i]), {method: 'DELETE'});
                }
            }, EXTRA.map(function (title) { return title.replace(/ /g, '-'); }));

            await waitForCount(links, function (count) { return count === initial; }, 'the Servers menu did not drop back to ' + initial + ' link(s) after removing the extra servers');
            await clickNav(page, 'a#dashboard', '');
        }
    }
}});

// Each tab shows exactly its own pane and takes the active class, and the route does not change
// (the Bootstrap data API prevents the link's default).
checks.push({name: 'server tabs', run: async function (page, state) {
    await openServer(page, state);

    var order = ['settings', 'info', 'players', 'mods', 'missions'];

    for (var i = 0; i < order.length; i++) {
        var tab = order[i];

        await openTab(page, tab);

        var end = Date.now() + WAIT_TIMEOUT;
        var read = function () {
            return page.evaluate(function () {
                return {
                    hash: window.location.hash,
                    panes: Array.prototype.filter.call(document.querySelectorAll('#content .tab-pane'), function (pane) {
                        return pane.getClientRects().length > 0 && getComputedStyle(pane).visibility !== 'hidden';
                    }).map(function (pane) { return pane.id; }),
                    // Whatever carries the active class (the link in Bootstrap 5, its li in Bootstrap 3), reported as the link it is or contains.
                    links: Array.prototype.map.call(document.querySelectorAll('ul.nav-tabs .active'), function (element) {
                        var link = element.matches('a') ? element : element.querySelector('a');

                        return link ? link.getAttribute('href') : '<' + element.tagName.toLowerCase() + ' without a link>';
                    })
                };
            });
        };
        var found = await read();
        var wrong = function (result) {
            if (result.hash !== state.serverHref) {
                return 'the hash is "' + result.hash + '", expected "' + state.serverHref + '"';
            }

            if (result.panes.length !== 1 || result.panes[0] !== 'tab-' + tab) {
                return 'the visible .tab-pane element(s) are ' + JSON.stringify(result.panes) + ', expected ["tab-' + tab + '"]';
            }

            if (result.links.length !== 1 || result.links[0] !== '#tab-' + tab) {
                return 'the ul.nav-tabs .active element(s) are ' + JSON.stringify(result.links) + ', expected ["#tab-' + tab + '"]';
            }

            return '';
        };

        while (wrong(found) !== '') {
            if (Date.now() > end) {
                throw new Error('after clicking the ' + tab + ' tab ' + wrong(found));
            }

            await sleep(100);
            found = await read();
        }

        if (tab === 'players') {
            var text = await page.locator('#tab-players').innerText({timeout: WAIT_TIMEOUT});

            if (text.trim() === '') {
                throw new Error('the Players tab is empty after clicking it');
            }
        }
    }
}});

// The two-column pages keep their side-by-side order on a wide screen.
checks.push({name: 'two-column layouts', run: async function (page, state) {
    await clickNav(page, 'a#missions', '#missions');
    await rowWithText(page, 'smoke').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var lefts = await page.evaluate(function () {
        return {
            upload: document.querySelector('#upload').getBoundingClientRect().left,
            list: document.querySelector('#content #list').getBoundingClientRect().left
        };
    });

    if (!(lefts.upload > lefts.list)) {
        throw new Error('the Missions upload card starts at x=' + lefts.upload + ' and the list at x=' + lefts.list + ', expected the card to the right of the list');
    }

    await openServer(page, state);
    await openTab(page, 'missions');
    await page.locator('#tab-missions #available tbody tr').first().waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    lefts = await page.evaluate(function () {
        return {
            rotation: document.querySelector('#tab-missions #rotation').getBoundingClientRect().left,
            available: document.querySelector('#tab-missions #available').getBoundingClientRect().left
        };
    });

    if (!(lefts.rotation > lefts.available)) {
        throw new Error('the rotation starts at x=' + lefts.rotation + ' and the available missions at x=' + lefts.available + ', expected the rotation to the right');
    }
}});

// A class rename can make a table or a form wider than a phone screen without any error.
checks.push({name: 'narrow pages do not scroll sideways', run: async function (page, state) {
    var pages = [
        {name: 'dashboard', hash: '', server: false, ready: function () { return page.locator('#content table tbody tr').first(); }},
        {name: 'server', hash: state.serverHref, server: true, ready: function () { return page.locator('#content h2').filter({hasText: 'Smoke Server'}); }},
        {name: 'missions', hash: '#missions', server: false, ready: function () { return rowWithText(page, 'smoke'); }},
        {name: 'mods', hash: '#mods', server: false, ready: function () { return rowWithText(page, '@smoke_mod'); }},
        {name: 'logs', hash: '#logs', server: false, ready: function () { return rowWithText(page, 'arma3server_smoke.log'); }},
        {name: 'op mode', hash: '#op-mode', server: false, ready: function () { return page.locator('#content h1').filter({hasText: 'Op Mode'}); }}
    ];

    await page.setViewportSize(NARROW);

    try {
        for (var i = 0; i < pages.length; i++) {
            await page.evaluate(function (hash) { window.location.hash = hash; }, pages[i].hash);
            await page.waitForFunction(function (args) {
                return window.location.hash === args.hash && (args.server || !document.querySelector('#content #tab-info'));
            }, {hash: pages[i].hash, server: pages[i].server}, {timeout: WAIT_TIMEOUT});
            await pages[i].ready().waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

            var width = await page.evaluate(function () { return document.documentElement.scrollWidth; });

            if (width > NARROW.width) {
                var wide = await page.evaluate(function (limit) {
                    return Array.prototype.filter.call(document.querySelectorAll('#content *'), function (element) {
                        return element.getBoundingClientRect().right > limit;
                    }).slice(0, 3).map(function (element) {
                        return element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\s+/).join('.') : '');
                    });
                }, NARROW.width);

                throw new Error('the ' + pages[i].name + ' page is ' + width + 'px wide at 375px, expected at most 375px (it scrolls sideways; first elements past the right edge: ' + (wide.join(', ') || 'none inside #content') + ')');
            }
        }
    } finally {
        await page.setViewportSize(DESKTOP);
    }
}});

checks.push({name: 'add-server modal', run: withModalCleanup(async function (page) {
    var before = serverPosts().length;

    var postsSent = function () {
        return serverPosts().length - before;
    };
    var assertNoPost = function (when) {
        if (postsSent() !== 0) {
            throw new Error(when + ' ' + postsSent() + ' POST(s) to /api/servers were sent, expected 0');
        }
    };

    await openAddServer(page);

    var modal = page.locator(MODAL_OPEN);

    await assertModalOpen(page, 'the open Add server modal');

    // Focus goes to OK once the modal is shown; focusing it must not scroll the modal down to the footer.
    await waitForFocusWithin(page, MODAL_OPEN + ' .btn.ok', 'the open Add server modal');

    var view = await page.evaluate(function () {
        var element = document.querySelector('.modal');
        var rect = element.querySelector('input.title').getBoundingClientRect();

        return {scrollTop: element.scrollTop, top: rect.top, bottom: rect.bottom, height: window.innerHeight};
    });

    if (view.scrollTop !== 0) {
        throw new Error('the open Add server modal is scrolled ' + view.scrollTop + 'px down, expected 0 (the focus on OK scrolled it)');
    }

    if (view.top < 0 || view.bottom > view.height) {
        throw new Error('input.title is at y=' + view.top + ' to ' + view.bottom + ' in a ' + view.height + 'px high viewport, expected it inside the viewport');
    }

    await settle(page);
    await screenshot(page, 'add-server-modal');
    await assertNoTemplateMarkers(modal, 'The add server modal');
    await assertNoDeadClasses(page, 'the Add server modal');

    // Enter in a field neither saves nor closes: the form has no submit button.
    await page.evaluate(function () { window.__smokeModalMarker = 'still-here'; });
    await modal.locator('input.title').press('Enter');
    await page.waitForTimeout(500);
    assertNoPost('after pressing Enter in the title field');
    await assertModalOpen(page, 'the Add server modal after Enter in the title field');

    if (await page.evaluate(function () { return window.__smokeModalMarker; }) !== 'still-here') {
        throw new Error('the page reloaded after pressing Enter in the title field');
    }

    // Never .ok here: that saves a new server. Cancel, Esc and a click on the backdrop all just close.
    await modal.locator('.btn.cancel').click({timeout: WAIT_TIMEOUT});
    await assertModalGone(page, 'after Cancel');
    assertNoPost('after Cancel');

    for (var i = 1; i <= 3; i++) {
        await openAddServer(page);
        await assertModalOpen(page, 'the Add server modal opened for the ' + i + '. time in a row');
        await page.locator(MODAL_OPEN + ' .btn.cancel').click({timeout: WAIT_TIMEOUT});
        await assertModalGone(page, 'after opening and cancelling ' + i + ' time(s)');
    }

    await openAddServer(page);
    await assertModalOpen(page, 'the Add server modal before Esc');
    await page.keyboard.press('Escape');
    await assertModalGone(page, 'after Esc');
    assertNoPost('after Esc');

    await openAddServer(page);
    await assertModalOpen(page, 'the Add server modal before the backdrop click');
    await page.mouse.click(5, 5);
    await assertModalGone(page, 'after a click on the backdrop');
    assertNoPost('after a click on the backdrop');
})});

checks.push({name: 'settings modal', run: withModalCleanup(async function (page) {
    // div#settings also exists in the server Settings tab, so always qualify the id.
    var open = async function () {
        await page.locator('#navigation a#settings').click({timeout: WAIT_TIMEOUT});
        await assertModalOpen(page, 'the open Settings modal');
        await page.locator(MODAL_OPEN + ' input[name=type]').first().waitFor({state: 'attached', timeout: WAIT_TIMEOUT});
    };

    await open();

    var modal = page.locator(MODAL_OPEN);
    var type = modal.locator('input[name=type]').first();

    if (!await type.isDisabled()) {
        throw new Error('input[name=type] is not disabled');
    }

    // This modal has no Cancel and no close button; OK only closes it.
    var dismissers = await modal.locator('.cancel, .btn-close, .close').count();

    if (dismissers !== 0) {
        throw new Error('the Settings modal has ' + dismissers + ' .cancel/.btn-close/.close element(s), expected 0');
    }

    var buttons = await modal.locator('.modal-footer .btn').allTextContents();

    if (buttons.length !== 1 || buttons[0].trim() !== 'OK') {
        throw new Error('the Settings modal footer has the button(s) ' + JSON.stringify(buttons) + ', expected exactly ["OK"]');
    }

    await settle(page);
    await screenshot(page, 'settings-modal');
    await assertNoTemplateMarkers(modal, 'The settings modal');
    await assertNoDeadClasses(page, 'the Settings modal');

    await modal.locator('.btn.ok').click({timeout: WAIT_TIMEOUT});
    await assertModalGone(page, 'after OK in the Settings modal');

    // Esc closes it too, and reopening renders the radios again.
    await open();
    await page.keyboard.press('Escape');
    await assertModalGone(page, 'after Esc in the Settings modal');

    await open();

    var radios = await page.locator(MODAL_OPEN + ' input[name=type]').count();

    if (radios < 1 || !await page.locator(MODAL_OPEN + ' input[name=type]').first().isDisabled()) {
        throw new Error('the reopened Settings modal has ' + radios + ' input[name=type] radio(s), expected at least 1, disabled');
    }

    await page.locator(MODAL_OPEN + ' .btn.ok').click({timeout: WAIT_TIMEOUT});
    await assertModalGone(page, 'after OK in the reopened Settings modal');
})});

// The Settings modal fades in. An OK clicked while it is still fading in must close it once the fade
// ends (Bootstrap ignores hide() mid-transition). The main context runs with reduced motion, which
// removes the fade, so this check uses its own context with the default motion setting.
checks.push({name: 'settings modal OK during the fade', run: async function (page, state) {
    var context = await browser.newContext({viewport: DESKTOP});

    try {
        var fadePage = await context.newPage();

        attachListeners(fadePage, state.origin);
        await fadePage.goto(state.origin + '/', {timeout: FIRST_LOAD_TIMEOUT});
        await fadePage.locator('#navigation .navbar').waitFor({state: 'visible', timeout: FIRST_LOAD_TIMEOUT});
        await fadePage.evaluate(function () {
            document.addEventListener('shown.bs.modal', function () { window.__smokeShown = true; });
        });

        var early = false;

        for (var attempt = 1; attempt <= 3 && !early; attempt++) {
            await fadePage.evaluate(function () { window.__smokeShown = false; });
            await fadePage.locator('#navigation a#settings').click({timeout: WAIT_TIMEOUT});
            await fadePage.locator('.modal .btn.ok').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

            // The click is dispatched in the page, so nothing waits for the animation to settle.
            early = await fadePage.evaluate(function () {
                var shown = window.__smokeShown === true;

                document.querySelector('.modal .btn.ok').click();

                return !shown;
            });

            await assertModalGone(fadePage, 'after OK clicked ' + (early ? 'during' : 'after') + ' the fade (attempt ' + attempt + ')');
        }

        if (!early) {
            throw new Error('in 3 attempts the OK click never came before the modal finished fading in, so the queued close was not exercised');
        }
    } finally {
        await context.close();
    }
}});

// R3: a second open() while a modal is still opening must show nothing. Two clicks in one task (as
// Enter pressed twice during the fade) must leave one .modal and one backdrop, and closing that modal
// must release the scroll lock.
checks.push({name: 'double open shows one modal', run: withModalCleanup(async function (page) {
    var cases = [
        {name: 'Settings', open: '#navigation a#settings', close: '.btn.ok'},
        {name: 'Add server', open: '#content a#add-server', close: '.btn.cancel'}
    ];

    await clickNav(page, 'a#dashboard', '');
    await page.locator('#content a.btn-primary#add-server').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    for (var i = 0; i < cases.length; i++) {
        var item = cases[i];

        await page.evaluate(function (selector) {
            var link = document.querySelector(selector);

            link.click();
            link.click();
        }, item.open);

        // Long enough for a stacked second modal to show up too.
        await sleep(500);
        await assertModalOpen(page, 'the ' + item.name + ' modal after two clicks in a row');

        await page.locator(MODAL_OPEN + ' ' + item.close).click({timeout: WAIT_TIMEOUT});
        await assertModalGone(page, 'after closing the ' + item.name + ' modal that was opened twice');
    }
})});

// B3: the save error alert opens over the Add server modal. Bootstrap's focus trap must not take the
// keyboard from it: Esc closes only the alert and Enter on its button must not save a second time.
// The route answers 200 with a body that is not JSON, which Backbone reports as a save error without
// an HTTP error status or a console error. This runs before every state-changing check.
checks.push({name: 'save error alert over the modal', run: withModalCleanup(async function (page) {
    var before = serverPosts().length;
    var postsSent = function () {
        return serverPosts().length - before;
    };
    var answer = async function (route) {
        if (route.request().method() === 'POST') {
            await route.fulfill({status: 200, contentType: 'application/json', body: 'not json'});
        } else {
            await route.continue();
        }
    };
    var modal = page.locator(MODAL_OPEN);
    var popup = page.locator('.swal2-popup');

    // The model's urlRoot ends in a slash, so the POST goes to /api/servers/.
    var saveUrl = /\/api\/servers\/?(\?.*)?$/;

    await page.route(saveUrl, answer);

    try {
        await openAddServer(page);
        await modal.locator('input.title').fill('Smoke Error', {timeout: WAIT_TIMEOUT});
        await modal.locator('.btn.ok').click({timeout: WAIT_TIMEOUT});

        try {
            await popup.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
        } catch (err) {
            var state = await page.evaluate(function () {
                var swal = document.querySelector('.swal2-popup');

                return {
                    modals: document.querySelectorAll('.modal').length,
                    containers: document.querySelectorAll('.swal2-container').length,
                    popup: swal ? 'present, display ' + getComputedStyle(swal).display + ', visibility ' + getComputedStyle(swal).visibility + ', class "' + swal.className + '"' : 'absent'
                };
            });

            throw new Error('after OK ' + postsSent() + ' POST(s) to /api/servers were sent, ' + state.modals + ' .modal and ' + state.containers + ' .swal2-container element(s), .swal2-popup ' + state.popup + '; expected 1 POST and a visible .swal2-popup', {cause: err});
        }

        var parent = await page.evaluate(function () {
            var container = document.querySelector('.swal2-popup').closest('.swal2-container');

            return container && container.parentElement ? container.parentElement.className : 'nothing';
        });

        if (!/(^|\s)modal(\s|$)/.test(parent)) {
            throw new Error('the alert container is a child of an element with class "' + parent + '", expected the .modal element');
        }

        await waitForFocusWithin(page, '.swal2-popup', 'with the error alert open');
        await assertNoDeadClasses(page, 'the save error alert');
        await settle(page);
        await screenshot(page, 'add-server-error-alert');

        // Esc closes the alert and nothing else.
        await page.keyboard.press('Escape');
        await popup.waitFor({state: 'hidden', timeout: WAIT_TIMEOUT});

        var modals = await page.locator(MODAL_OPEN).count();

        if (modals !== 1) {
            throw new Error('after Esc on the alert there are ' + modals + ' .modal.show element(s), expected 1');
        }

        var title = await modal.locator('input.title').inputValue({timeout: WAIT_TIMEOUT});

        if (title !== 'Smoke Error') {
            throw new Error('after Esc on the alert the title field holds "' + title + '", expected "Smoke Error"');
        }

        if (postsSent() !== 1) {
            throw new Error('after the first OK ' + postsSent() + ' POST(s) to /api/servers were sent, expected 1');
        }

        await waitForFocusWithin(page, '.modal', 'within 1 s of closing the alert with Esc', 1000);

        // OK again, then Enter on the alert's button: closes the alert, saves nothing more.
        await modal.locator('.btn.ok').click({timeout: WAIT_TIMEOUT});
        await popup.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
        await waitForFocusWithin(page, '.swal2-popup', 'with the error alert open for the second time');
        await page.keyboard.press('Enter');
        await popup.waitFor({state: 'hidden', timeout: WAIT_TIMEOUT});
        await page.waitForTimeout(500);

        if (postsSent() !== 2) {
            throw new Error('after Enter on the alert ' + postsSent() + ' POST(s) to /api/servers were sent, expected exactly 2');
        }

        modals = await page.locator(MODAL_OPEN).count();

        if (modals !== 1) {
            throw new Error('after Enter on the alert there are ' + modals + ' .modal.show element(s), expected 1');
        }

        await modal.locator('.btn.cancel').click({timeout: WAIT_TIMEOUT});
        await assertModalGone(page, 'after Cancel behind the alert');
    } finally {
        await page.unroute(saveUrl, answer);

        // Best effort, so a failure above does not leave a modal over every later check.
        try {
            if (await popup.count() > 0) {
                await page.keyboard.press('Escape');
                await popup.waitFor({state: 'hidden', timeout: 2000});
            }

            if (await page.locator('.modal').count() > 0) {
                await page.locator('.modal .btn.cancel').click({timeout: 2000});
                await page.locator('.modal').waitFor({state: 'detached', timeout: 2000});
            }
        } catch (e) {
            // The failure reported above is the one that matters.
        }
    }
})});

// A status-only socket push (ping, players, pid) must not wipe unsaved edits on the server page:
// the backend pushes the whole server list every few seconds while a server runs, and each push
// used to re-render the Settings, Mods, Parameters and Missions tabs. The pushes are injected into
// the browser's own socket, so the app and servers.json never see them and nothing is saved. A
// second page keeps the shared page untouched for the checks that follow.
checks.push({name: 'status push keeps unsaved edits', run: async function (page, state) {
    var smokeStatePlayers = function (names) {
        return names.map(function (name, index) {
            return {name: name, raw: {score: index + 1}};
        });
    };

    var page2 = await page.context().newPage();

    try {
        attachListeners(page2, state.origin);

        // The page's websocket is relayed to the real server untouched; `socket.ws` is kept so a
        // frame can be injected towards the page. `upgraded` turns true when the page has sent the
        // engine.io upgrade packet '5' (after `2probe` / `3probe`), i.e. once the client has
        // switched to the websocket transport and treats frames on it as socket.io packets.
        var socket = {ws: null, upgraded: false};

        await page2.routeWebSocket(/\/socket\.io\//, function (ws) {
            var server = ws.connectToServer();

            socket.ws = ws;
            socket.upgraded = false;

            // A message handler turns off the automatic forwarding, so both directions are relayed here.
            ws.onMessage(function (message) {
                if (message === '5') {
                    socket.upgraded = true;
                }

                server.send(message);
            });
            server.onMessage(function (message) {
                ws.send(message);
            });
            ws.onClose(function (code, reason) {
                server.close({code: code, reason: reason});
            });
            server.onClose(function (code, reason) {
                ws.close({code: code, reason: reason});
            });
        });

        await page2.goto(state.origin + '/' + state.serverHref, {timeout: WAIT_TIMEOUT});
        await page2.locator('#content h2').filter({hasText: 'Smoke Server'}).waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

        var end = Date.now() + WAIT_TIMEOUT;

        while (!socket.upgraded) {
            if (Date.now() > end) {
                throw new Error('the page did not send the engine.io upgrade packet "5" within ' + WAIT_TIMEOUT + ' ms, so no push can be injected');
            }

            await sleep(100);
        }

        var list = await page2.evaluate(async function () {
            return (await fetch('/api/servers')).json();
        });

        if (!list.some(function (server) { return server.title === 'Smoke Server'; })) {
            throw new Error('GET /api/servers has no server titled "Smoke Server"');
        }

        // Pushes the full list with only the Smoke Server entry changed, as the backend does.
        var push = function (changes) {
            var pushed = list.map(function (server) {
                if (server.title !== 'Smoke Server') {
                    return server;
                }

                var copy = JSON.parse(JSON.stringify(server));

                Object.keys(changes).forEach(function (key) {
                    copy[key] = changes[key];
                });

                return copy;
            });

            socket.ws.send('42' + JSON.stringify(['servers', pushed]));
        };

        var online = function (players, ping) {
            return {
                name: 'Smoke Server',
                map: 'Altis',
                raw: {game: 'Smoke Mission'},
                players: smokeStatePlayers(players),
                maxplayers: 32,
                ping: ping
            };
        };

        // Unsaved edits on every editable tab.
        await openTab(page2, 'settings');
        await page2.locator('#tab-settings #settings input.max-players').fill('48', {timeout: WAIT_TIMEOUT});
        await page2.locator('#tab-settings #settings input.persistent').check({timeout: WAIT_TIMEOUT});

        await openTab(page2, 'mods');

        var modRow = page2.locator('#tab-mods tbody tr').filter({hasText: '@smoke_mod'}).first();
        await modRow.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
        await modRow.locator('input[type=checkbox]').check({timeout: WAIT_TIMEOUT});

        await openTab(page2, 'settings');
        await page2.locator('#tab-settings #parameters .add-parameter').click({timeout: WAIT_TIMEOUT});

        var parameterInput = page2.locator('#tab-settings #parameters tbody tr input#parameter').first();
        await parameterInput.fill('-smoke', {timeout: WAIT_TIMEOUT});
        // Tab blurs the input, which fires the change event that stores the value in the row's model.
        await parameterInput.press('Tab', {timeout: WAIT_TIMEOUT});

        await openTab(page2, 'missions');

        var available = page2.locator('#tab-missions #available tbody tr').filter({hasText: 'smoke'}).first();
        await available.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
        await available.locator('a.add').click({timeout: WAIT_TIMEOUT});

        var rotation = page2.locator('#tab-missions #rotation tbody tr');
        await waitForCount(rotation, function (count) { return count === 1; }, 'the rotation did not get 1 row after Add');
        await rotation.first().locator('select#difficulty').selectOption('veteran', {timeout: WAIT_TIMEOUT});

        // Inactive tab panes are display: none, so everything below reads values and counts, never visibility.
        var assertEdits = async function (label) {
            var problems = [];
            var expect = function (field, expected, actual) {
                if (actual !== expected) {
                    problems.push(field + ' is ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
                }
            };

            var maxPlayers = page2.locator('#tab-settings #settings input.max-players');

            if (await maxPlayers.count() === 1) {
                expect('max players', '48', await maxPlayers.inputValue({timeout: WAIT_TIMEOUT}));
            } else {
                problems.push('max players input count is ' + await maxPlayers.count() + ', expected 1');
            }

            var persistent = page2.locator('#tab-settings #settings input.persistent');

            if (await persistent.count() === 1) {
                expect('persistent checked', true, await persistent.isChecked({timeout: WAIT_TIMEOUT}));
            } else {
                problems.push('persistent checkbox count is ' + await persistent.count() + ', expected 1');
            }

            var modBox = page2.locator('#tab-mods tbody tr').filter({hasText: '@smoke_mod'}).locator('input[type=checkbox]');

            if (await modBox.count() === 1) {
                expect('@smoke_mod checked', true, await modBox.isChecked({timeout: WAIT_TIMEOUT}));
            } else {
                problems.push('@smoke_mod checkbox count is ' + await modBox.count() + ', expected 1');
            }

            var parameterRows = page2.locator('#tab-settings #parameters tbody tr');
            var parameterCount = await parameterRows.count();

            expect('parameter row count', 1, parameterCount);

            if (parameterCount === 1) {
                expect('parameter value', '-smoke', await parameterRows.first().locator('input#parameter').inputValue({timeout: WAIT_TIMEOUT}));
            }

            var rotationCount = await rotation.count();

            expect('rotation row count', 1, rotationCount);

            if (rotationCount === 1) {
                expect('rotation mission name', 'smoke.Altis', await rotation.first().locator('input#name').inputValue({timeout: WAIT_TIMEOUT}));
                expect('rotation difficulty', 'veteran', await rotation.first().locator('select#difficulty').inputValue({timeout: WAIT_TIMEOUT}));
            }

            if (problems.length > 0) {
                throw new Error('unsaved edits were lost after push ' + label + ': ' + problems.join('; '));
            }
        };

        var waitForMarker = async function (label, description, fn, arg) {
            try {
                await page2.waitForFunction(fn, arg, {timeout: WAIT_TIMEOUT});
            } catch (err) {
                throw new Error('push ' + label + ' did not show ' + description, {cause: err});
            }
        };

        // (a) the server goes online: pid and state arrive.
        push({pid: 4242, state: online(['Alpha'], 10)});
        await page2.locator('#tab-info :is(.label-success, .badge.text-bg-success)').waitFor({state: 'attached', timeout: WAIT_TIMEOUT})
            .catch(function (err) { throw new Error('push (a) did not show the Online label in the Info tab', {cause: err}); });
        await assertEdits('(a) pid and state');

        // (b) a player joins: only the state changes.
        push({pid: 4242, state: online(['Alpha', 'Bravo'], 12)});
        await waitForMarker('(b)', 'Bravo in the Players tab', function () {
            var pane = document.querySelector('#tab-players');

            return !!pane && pane.textContent.indexOf('Bravo') !== -1;
        });
        await assertEdits('(b) state only');

        // (c) the server stops.
        push({pid: null, state: null});
        await page2.locator('#tab-info :is(.label-default, .badge.text-bg-secondary)').waitFor({state: 'attached', timeout: WAIT_TIMEOUT})
            .catch(function (err) { throw new Error('push (c) did not show the Offline label in the Info tab', {cause: err}); });
        await assertEdits('(c) pid and state cleared');

        // A push that changes configuration still refreshes the page. It re-renders the editable
        // tabs and so drops the edits above, which is intended; nothing is asserted about them.
        push({pid: null, state: null, port: 2310});
        await waitForMarker('with a new port', 'port 2310 in the Settings form and the Info tab', function () {
            var input = document.querySelector('#tab-settings #settings input.port');
            var info = document.querySelector('#tab-info');

            return !!input && input.value === '2310' && !!info && info.textContent.indexOf('2310') !== -1;
        });
    } finally {
        await page2.close();
    }
}});

// The checks below change server state; keep them last and in this order. B10 deletes every server.

// B6: Add on an available mission puts it in the rotation.
checks.push({name: 'add mission to rotation', run: async function (page, state) {
    await openServer(page, state);
    await openTab(page, 'missions');

    var rotation = page.locator('#tab-missions #rotation tbody tr');
    var before = await rotation.count();

    if (before !== 0) {
        throw new Error('expected an empty rotation, found ' + before + ' row(s)');
    }

    var row = page.locator('#tab-missions #available tbody tr').filter({hasText: 'smoke'}).first();
    await row.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await row.locator('a.add').click({timeout: WAIT_TIMEOUT});

    await waitForCount(rotation, function (count) { return count === 1; }, 'the rotation did not get 1 row after Add');

    var name = await rotation.first().locator('input#name').inputValue({timeout: WAIT_TIMEOUT});

    if (name !== 'smoke.Altis') {
        throw new Error('the rotation row name is "' + name + '", expected "smoke.Altis"');
    }
}});

// B7: Save sends the edited settings and the rotation, and the server page shows them again.
checks.push({name: 'server save', run: async function (page, state) {
    var id = state.serverHref.replace(/^#servers\//, '');

    await openTab(page, 'settings');
    await page.locator('#tab-settings #settings input.max-players').fill('40', {timeout: WAIT_TIMEOUT});

    var saved = page.waitForResponse(function (response) {
        return response.request().method() === 'PUT' && response.url().indexOf('/api/servers/' + id) !== -1;
    }, {timeout: WAIT_TIMEOUT});

    await page.locator('#content form > button[type=submit]').click({timeout: WAIT_TIMEOUT});

    var response = await saved;

    if (response.status() !== 200) {
        throw new Error('PUT /api/servers/' + id + ' answered ' + response.status());
    }

    // The server itself, not the form: the API must hold the saved max players and the rotation.
    var savedJson = await page.evaluate(async function (serverId) {
        var res = await fetch('/api/servers/' + encodeURIComponent(serverId));

        return {status: res.status, body: await res.json()};
    }, id);

    if (savedJson.status !== 200) {
        throw new Error('GET /api/servers/' + id + ' answered ' + savedJson.status + ' after saving');
    }

    if (String(savedJson.body.max_players) !== '40') {
        throw new Error('the API holds max_players ' + JSON.stringify(savedJson.body.max_players) + ' after saving, expected 40');
    }

    var savedMissions = Array.isArray(savedJson.body.missions) ? savedJson.body.missions : [];

    if (!savedMissions.some(function (mission) { return mission && mission.name === 'smoke.Altis'; })) {
        throw new Error('the API missions are ' + JSON.stringify(savedJson.body.missions) + ' after saving, expected an entry named "smoke.Altis"');
    }

    await openServer(page, state);

    var maxPlayers = await page.locator('#tab-settings #settings input.max-players').inputValue({timeout: WAIT_TIMEOUT});

    if (maxPlayers !== '40') {
        throw new Error('max players is "' + maxPlayers + '" after saving and reopening, expected "40"');
    }

    await openTab(page, 'missions');

    var rotation = page.locator('#tab-missions #rotation tbody tr');
    await waitForCount(rotation, function (count) { return count === 1; }, 'the rotation does not have 1 row after saving and reopening');

    var name = await rotation.first().locator('input#name').inputValue({timeout: WAIT_TIMEOUT});

    if (name !== 'smoke.Altis') {
        throw new Error('the rotation row name is "' + name + '" after saving and reopening, expected "smoke.Altis"');
    }
}});

// B8: the Add server modal's OK button creates the server and opens its page.
checks.push({name: 'add server through the modal', run: withModalCleanup(async function (page) {
    var before = serverPosts().length;

    await openAddServer(page);

    var modal = page.locator(MODAL_OPEN);
    await modal.locator('input.title').fill('Smoke Two', {timeout: WAIT_TIMEOUT});
    await modal.locator('.btn.ok').click({timeout: WAIT_TIMEOUT});

    await assertModalGone(page, 'after OK in the Add server modal');

    var posts = serverPosts().slice(before);

    if (posts.length !== 1) {
        throw new Error(posts.length + ' POST(s) to /api/servers, expected 1');
    }

    var sent;

    try {
        sent = JSON.parse(posts[0].postData).title;
    } catch (err) {
        throw new Error('the POST to /api/servers has no JSON body: ' + JSON.stringify(posts[0].postData), {cause: err});
    }

    if (sent !== 'Smoke Two') {
        throw new Error('the POST to /api/servers has the title ' + JSON.stringify(sent) + ', expected "Smoke Two"');
    }

    try {
        await page.waitForFunction(function () {
            return window.location.hash === '#servers/Smoke-Two';
        }, null, {timeout: WAIT_TIMEOUT});
    } catch (err) {
        var hash = await page.evaluate(function () { return window.location.hash; });
        throw new Error('the hash is "' + hash + '" after adding a server, expected "#servers/Smoke-Two"', {cause: err});
    }

    var heading = page.locator('#content h2').filter({hasText: 'Smoke Two'});
    await heading.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var text = (await heading.textContent({timeout: WAIT_TIMEOUT})).trim();

    if (text !== 'Smoke Two') {
        throw new Error('the page heading is "' + text + '", expected "Smoke Two"');
    }
})});

// B9: a server created outside the page reaches the open page through the socket push.
checks.push({name: 'socket push re-renders lists', run: async function (page) {
    await page.locator('#navigation a#dashboard').click({timeout: WAIT_TIMEOUT});

    var rows = page.locator('#content table tbody tr');
    var navItems = page.locator('#servers-list > li');

    await rows.first().waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var rowsBefore = await rows.count();
    var navBefore = await navItems.count();

    await page.evaluate(function () { window.__smokePushMarker = 'still-here'; });

    var status = await page.evaluate(async function (body) {
        var response = await fetch('/api/servers', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });

        return response.status;
    }, serverFixture('Smoke Push'));

    if (status !== 200) {
        throw new Error('POST /api/servers answered ' + status);
    }

    await waitForCount(rows, function (count) { return count === rowsBefore + 1; }, 'the servers table did not grow to ' + (rowsBefore + 1) + ' row(s) after the push');
    await page.locator('#content table tbody a[href="#servers/Smoke-Push"]').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await waitForCount(navItems, function (count) { return count === navBefore + 1; }, 'the servers dropdown did not grow to ' + (navBefore + 1) + ' item(s) after the push');

    var marker = await page.evaluate(function () { return window.__smokePushMarker; });

    if (marker !== 'still-here') {
        throw new Error('the page reloaded');
    }
}});

// B12: a socket push that adds, removes and reorders nothing must not touch the list rows. Under
// Marionette 4 every merging set() re-attached all children, so focus fell back to <body> and a text
// selection in the table was cleared every few seconds.
checks.push({name: 'no-op push keeps list rows', run: async function (page) {
    await page.locator('#navigation a#dashboard').click({timeout: WAIT_TIMEOUT});

    var rows = page.locator('#content table tbody tr');
    await waitForCount(rows, function (count) { return count === 3; }, 'the servers table does not have 3 rows before the push');

    var start = rowWithText(page, 'Smoke Two').locator('button.start');
    await start.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await start.focus({timeout: WAIT_TIMEOUT});

    var before = await page.evaluate(function () {
        var tbody = document.querySelector('#content table tbody');
        var list = document.querySelector('ul#servers-list');
        var active = document.activeElement;

        if (!tbody || !list || !active || !active.classList.contains('start')) {
            return {ok: false, active: active ? active.tagName + '.' + active.className : 'none', tbody: !!tbody, list: !!list};
        }

        window.__smokeStartButton = active;
        window.__smokeRecords = {tbody: [], list: []};

        var observe = function (target, records) {
            var observer = new MutationObserver(function (batch) {
                batch.forEach(function (record) { records.push(record); });
            });

            observer.observe(target, {childList: true});

            return observer;
        };

        window.__smokeObservers = [
            observe(tbody, window.__smokeRecords.tbody),
            observe(list, window.__smokeRecords.list)
        ];

        return {ok: true};
    });

    if (!before.ok) {
        throw new Error('could not set up: ' + JSON.stringify(before));
    }

    var result = await page.evaluate(async function () {
        var url = '/api/servers/Smoke-Server';
        var current = await (await fetch(url)).json();

        current.port = current.port + 10;

        var response = await fetch(url, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(current)
        });

        return {status: response.status, port: current.port};
    });

    if (result.status !== 200) {
        throw new Error('PUT /api/servers/Smoke-Server answered ' + result.status);
    }

    // The Smoke Server row re-renders itself on the model change, so its new port proves the push arrived.
    try {
        await page.waitForFunction(function (port) {
            var cell = Array.prototype.filter.call(document.querySelectorAll('#content table tbody tr'), function (row) {
                return row.textContent.indexOf('Smoke Server') !== -1;
            }).map(function (row) { return row.children[2]; })[0];

            return !!cell && cell.textContent.trim() === String(port);
        }, result.port, {timeout: WAIT_TIMEOUT});
    } catch (err) {
        throw new Error('the Smoke Server row did not show port ' + result.port + ' after the push', {cause: err});
    }

    // Let any trailing mutation records be delivered before they are read.
    await sleep(500);

    var after = await page.evaluate(function () {
        var describe = function (record) {
            var names = function (nodes) {
                return Array.prototype.map.call(nodes, function (node) {
                    return node.nodeName.toLowerCase() + (node.textContent ? '(' + node.textContent.replace(/\s+/g, ' ').trim().slice(0, 30) + ')' : '');
                }).join(',');
            };

            return 'removed [' + names(record.removedNodes) + '] added [' + names(record.addedNodes) + ']';
        };

        window.__smokeObservers.forEach(function (observer) { observer.disconnect(); });

        var active = document.activeElement;

        return {
            tbody: window.__smokeRecords.tbody.map(describe),
            list: window.__smokeRecords.list.map(describe),
            sameButton: active === window.__smokeStartButton,
            active: active ? active.tagName.toLowerCase() + (active.className ? '.' + String(active.className).replace(/\s+/g, '.') : '') : 'none'
        };
    });

    var problems = [];

    if (after.tbody.length > 0) {
        problems.push('a push that changed one port moved ' + after.tbody.length + ' mutation(s) in the servers table body: ' + after.tbody.join(' | '));
    }

    if (after.list.length > 0) {
        problems.push('a push that changed one port moved ' + after.list.length + ' mutation(s) in the Servers dropdown: ' + after.list.join(' | '));
    }

    if (!after.sameButton) {
        problems.push('focus left the Smoke Two Start button after the push, document.activeElement is ' + after.active);
    }

    if (problems.length > 0) {
        throw new Error(problems.join('; '));
    }
}});

// B10: with no servers left the list shows its empty view, and its button still opens the modal.
checks.push({name: 'empty server list', run: withModalCleanup(async function (page) {
    await page.locator('#navigation a#dashboard').click({timeout: WAIT_TIMEOUT});
    await page.locator('#content table tbody tr').first().waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var statuses = await page.evaluate(async function () {
        var list = await (await fetch('/api/servers')).json();
        var result = [];

        for (var i = 0; i < list.length; i++) {
            var response = await fetch('/api/servers/' + encodeURIComponent(list[i].id), {method: 'DELETE'});

            result.push(response.status);
        }

        return result;
    });

    if (statuses.length === 0 || statuses.some(function (status) { return status !== 200; })) {
        throw new Error('deleting the servers answered ' + JSON.stringify(statuses));
    }

    var rows = page.locator('#content table tbody tr');
    await waitForCount(rows, function (count) { return count === 1; }, 'the servers table does not have exactly 1 row after deleting every server');

    var rowText = await rows.first().innerText({timeout: WAIT_TIMEOUT});

    if (rowText.indexOf('Create your first server!') === -1) {
        throw new Error('the only row does not say "Create your first server!": ' + JSON.stringify(rowText));
    }

    await rows.first().locator('a#add-server').click({timeout: WAIT_TIMEOUT});

    var modal = page.locator(MODAL_OPEN);
    await modal.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await modal.locator('input.title').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoTemplateMarkers(modal, 'The add server modal from the empty list');

    await modal.locator('.btn.cancel').click({timeout: WAIT_TIMEOUT});
    await assertModalGone(page, 'after Cancel in the Add server modal from the empty list');
})});

var CHECK_COUNT = checks.length;

// First line of the message plus the selector line of a Playwright call log, so a timeout names the marker.
var describeError = function (error) {
    if (!error || !error.message) {
        return String(error);
    }

    var lines = String(error.message).split('\n');
    var detail = lines.filter(function (line) {
        return /waiting for /.test(line);
    })[0];

    return detail ? lines[0] + ' ' + detail.trim() : lines[0];
};

var runChecks = async function (page, origin) {
    var state = {origin: origin};

    for (var i = 0; i < checks.length; i++) {
        currentCheck = checks[i].name;

        try {
            await checks[i].run(page, state);
        } catch (error) {
            fail(currentCheck, describeError(error));
        }
    }

    currentCheck = 'teardown';
};

var main = async function () {
    var env = await createEnvironment();
    var origin = 'http://127.0.0.1:' + env.port;

    if (screenshotDir) {
        fs.mkdirSync(screenshotDir, {recursive: true});
    }

    startApp(env);

    currentCheck = 'startup';
    await waitForStatus200(origin + '/', HOME_READY_DEADLINE, 'GET /', env);
    await waitForStatus200(origin + '/bundle.js', BUNDLE_READY_DEADLINE, 'GET /bundle.js', env);

    browser = await playwright.chromium.launch({
        headless: true,
        // The runner's cleanup owns signal handling, so the app child is always stopped.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
    });

    // Reduced motion removes the Bootstrap transitions, so no click races a fade. The one check that
    // needs the fade ('settings modal OK during the fade') opens its own context without it.
    var context = await browser.newContext({viewport: DESKTOP, reducedMotion: 'reduce'});
    var page = await context.newPage();

    attachListeners(page, origin);

    await runChecks(page, origin);
};

var doCleanup = async function () {
    if (browser) {
        try {
            await browser.close();
        } catch (e) {
            // The browser is already gone.
        }
    }

    if (child && !childExited) {
        await new Promise(function (resolve) {
            var timer = setTimeout(function () {
                child.kill('SIGKILL');
            }, KILL_GRACE);

            child.on('exit', function () {
                clearTimeout(timer);
                resolve();
            });

            child.kill('SIGTERM');
        });
    }
};

var cleanup = function () {
    // Later callers wait for the cleanup already in flight instead of returning early.
    cleanupPromise = cleanupPromise || doCleanup();
    return cleanupPromise;
};

var report = function () {
    var ok = failures.length === 0;

    if (ok) {
        if (root && !process.env.SMOKE_KEEP) {
            fs.rmSync(root, {recursive: true, force: true});
        } else if (root) {
            console.log('smoke: kept ' + root);
        }

        console.log('smoke: passed (' + CHECK_COUNT + ' checks)');
        return 0;
    }

    failures.forEach(function (line) {
        console.log(line);
    });
    console.log('smoke: failed (' + failures.length + ' failures)');

    if (root) {
        console.log('smoke: temp directory kept at ' + root);
    }

    return 1;
};

var onSignal = function (signal, code) {
    process.on(signal, function () {
        fail('run', 'interrupted by ' + signal);
        cleanup().then(function () {
            process.exitCode = report() || code;
            process.exit();
        });
    });
};

onSignal('SIGINT', 130);
onSignal('SIGTERM', 143);

var guard = new Promise(function (resolve) {
    var timer = setTimeout(function () {
        fail(currentCheck, 'the run took longer than ' + (OVERALL_LIMIT / 60000) + ' minutes');
        resolve();
    }, OVERALL_LIMIT);

    timer.unref();
});

Promise.race([main(), guard])
    .catch(function (error) {
        fail(currentCheck, error && error.message ? error.message : String(error));
    })
    .then(cleanup)
    .then(function () {
        process.exitCode = report();
        process.exit();
    });
