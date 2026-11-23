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

var CHECK_COUNT = 21;
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
        requests.push({method: request.method(), url: request.url()});
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

    await page.locator('#content .glyphicon').first().waitFor({state: 'attached', timeout: WAIT_TIMEOUT});

    var fonts = await page.evaluate(async function () {
        await document.fonts.ready;

        var loaded = false;
        document.fonts.forEach(function (font) {
            if (font.family.replace(/["']/g, '') === 'Glyphicons Halflings' && font.status === 'loaded') {
                loaded = true;
            }
        });

        return {
            loaded: loaded,
            fontFamily: getComputedStyle(document.querySelector('#content .glyphicon')).fontFamily
        };
    });

    if (!fonts.loaded) {
        throw new Error('the Glyphicons Halflings font is not loaded');
    }

    if (fonts.fontFamily.indexOf('Glyphicons Halflings') === -1) {
        throw new Error('.glyphicon font-family is "' + fonts.fontFamily + '"');
    }

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

    var active = page.locator('#servers-list > li.active > a');
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

    await openTab(page, 'mods');

    var modRow = page.locator('#tab-mods tbody tr').filter({hasText: '@smoke_mod'});
    await modRow.first().waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    if (await modRow.first().locator('input[type=checkbox]').isChecked({timeout: WAIT_TIMEOUT})) {
        throw new Error('the checkbox of @smoke_mod is checked, the server has no mods');
    }

    await openTab(page, 'missions');
    await page.locator('#tab-missions #available tbody tr').filter({hasText: 'smoke'}).first()
        .waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await page.locator('#tab-missions #rotation a.add-mission').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    await openTab(page, 'players');

    var playersText = await page.locator('#tab-players').innerText({timeout: WAIT_TIMEOUT});

    if (playersText.indexOf('Server not online') === -1) {
        throw new Error('the Players tab does not show "Server not online": ' + JSON.stringify(playersText));
    }

    await openTab(page, 'settings');

    var title = await page.locator('#tab-settings #settings input.title').inputValue({timeout: WAIT_TIMEOUT});

    if (title !== 'Smoke Server') {
        throw new Error('the Settings tab title input holds "' + title + '"');
    }

    await page.locator('#tab-settings #parameters a.add-parameter').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
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
    await screenshotBoth(page, 'mods');
}});

checks.push({name: 'logs', run: async function (page) {
    await clickNav(page, 'a#logs', '#logs');
    await rowWithText(page, 'arma3server_smoke.log').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
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

    await popup.locator('.swal2-cancel').click({timeout: WAIT_TIMEOUT});
    await popup.waitFor({state: 'hidden', timeout: WAIT_TIMEOUT});
    await page.waitForTimeout(1000);

    if (deletes() !== deletesBefore) {
        throw new Error('a DELETE request to /api/logs/ was sent after cancelling the delete confirm');
    }

    await rowWithText(page, 'arma3server_smoke.log').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
}});

checks.push({name: 'op-mode', run: async function (page) {
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

    await screenshotBoth(page, 'op-mode');

    await run.click({timeout: WAIT_TIMEOUT});

    var dialog = page.locator('.swal2-popup');
    await dialog.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var cancel = dialog.locator('.swal2-cancel');
    await cancel.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    await settle(page);
    await screenshot(page, 'op-mode-run-confirm');

    // Never the confirm button: that would stop servers.
    await cancel.click({timeout: WAIT_TIMEOUT});
    await dialog.waitFor({state: 'hidden', timeout: WAIT_TIMEOUT});

    if (runPosts() !== before) {
        throw new Error('POST /api/op-mode/run was sent');
    }
}});

// B1: the navbar marks exactly the link of the current route as active.
var assertActiveNav = async function (page, linkSelector) {
    var read = function () {
        return page.evaluate(function (selector) {
            var items = document.querySelectorAll('#navigation ul.navbar-nav > li.active');

            return {
                count: items.length,
                hasLink: items.length === 1 && items[0].querySelector(selector) !== null
            };
        }, linkSelector);
    };
    var end = Date.now() + WAIT_TIMEOUT;
    var result = await read();

    while (result.count !== 1 || !result.hasLink) {
        if (Date.now() > end) {
            throw new Error('after opening ' + linkSelector + ' the navbar has ' + result.count + ' active item(s)' +
                (result.count === 1 ? ' and it does not contain that link' : ' (expected exactly 1, containing that link)'));
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

// An unrendered template shows up as literal {{placeholder}} text, e.g. when _.templateSettings is lost.
var assertNoTemplateMarkers = async function (modal, label) {
    var text = await modal.innerText({timeout: WAIT_TIMEOUT});
    if (/\{\{|\}\}/.test(text)) {
        throw new Error(label + ' shows unrendered template text: ' + JSON.stringify(text));
    }
};

checks.push({name: 'add-server modal', run: async function (page) {
    var serverPosts = function () {
        return requests.filter(function (request) {
            return request.method === 'POST' && /\/api\/servers\/?(\?.*)?$/.test(request.url);
        }).length;
    };
    var before = serverPosts();

    await page.locator('#navigation a#dashboard').click({timeout: WAIT_TIMEOUT});
    await page.locator('#content a.btn-primary#add-server').click({timeout: WAIT_TIMEOUT});

    var modal = page.locator('.modal.in');
    await modal.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await modal.locator('input.title').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    await settle(page);
    await screenshot(page, 'add-server-modal');
    await assertNoTemplateMarkers(modal, 'The add server modal');

    // Never .ok: that saves a new server.
    await modal.locator('a.btn.cancel').click({timeout: WAIT_TIMEOUT});
    await page.locator('.modal.in').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});
    await page.locator('.modal-backdrop').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});

    if (serverPosts() !== before) {
        throw new Error('POST /api/servers was sent');
    }
}});

checks.push({name: 'settings modal', run: async function (page) {
    // div#settings also exists in the server Settings tab, so always qualify the id.
    await page.locator('#navigation a#settings').click({timeout: WAIT_TIMEOUT});

    var modal = page.locator('.modal.in');
    await modal.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var type = modal.locator('input[name=type]').first();
    await type.waitFor({state: 'attached', timeout: WAIT_TIMEOUT});

    if (!await type.isDisabled()) {
        throw new Error('input[name=type] is not disabled');
    }

    await settle(page);
    await screenshot(page, 'settings-modal');
    await assertNoTemplateMarkers(modal, 'The settings modal');

    // This modal has no Cancel; OK only closes it.
    await modal.locator('a.btn.ok').click({timeout: WAIT_TIMEOUT});
    await page.locator('.modal.in').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});
    await page.locator('.modal-backdrop').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});
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
checks.push({name: 'add server through the modal', run: async function (page) {
    await page.locator('#navigation a#dashboard').click({timeout: WAIT_TIMEOUT});
    await page.locator('#content a.btn-primary#add-server').click({timeout: WAIT_TIMEOUT});

    var modal = page.locator('.modal.in');
    await modal.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await modal.locator('input.title').fill('Smoke Two', {timeout: WAIT_TIMEOUT});
    await modal.locator('a.btn.ok').click({timeout: WAIT_TIMEOUT});

    await page.locator('.modal.in').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});
    await page.locator('.modal-backdrop').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});

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
}});

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
checks.push({name: 'empty server list', run: async function (page) {
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

    var modal = page.locator('.modal.in');
    await modal.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await modal.locator('input.title').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await assertNoTemplateMarkers(modal, 'The add server modal from the empty list');

    await modal.locator('a.btn.cancel').click({timeout: WAIT_TIMEOUT});
    await page.locator('.modal.in').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});
    await page.locator('.modal-backdrop').waitFor({state: 'detached', timeout: WAIT_TIMEOUT});
}});

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

    var context = await browser.newContext({viewport: DESKTOP});
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
