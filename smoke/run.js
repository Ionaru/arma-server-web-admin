// Frontend smoke run: starts the real app against a throw-away config and data directory, drives it
// with headless Chromium like a user, and fails on any console error, page error, HTTP error from
// the app or failed script, stylesheet or font request. Nothing under the repo is touched.
//
//   node smoke/run.js
//
// Environment: SMOKE_SCREENSHOTS=<dir> saves PNGs, SMOKE_KEEP=1 keeps the temp directory.
/* global window, document, getComputedStyle -- used inside page.evaluate callbacks, which run in the browser */
var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');

var playwright = require('@playwright/test');

var repoRoot = path.resolve(__dirname, '..');

var CHECK_COUNT = 9;
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

    // Every field Server.prototype.update reads, so loading and rendering log no error.
    var servers = [{
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
        title: 'Smoke Server',
        von: false,
        verify_signatures: false
    }];

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

checks.push({name: 'missions', run: async function (page) {
    await clickNav(page, 'a#missions', '#missions');
    await rowWithText(page, 'smoke').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await screenshotBoth(page, 'missions');
}});

// Uploads through the real form (FormData over XHR). The file input is named `missions` and shares
// its id with the navbar link, so it is addressed through its panel. The mission list refreshes via
// the socket `missions` event, not through the upload view.
var uploadPosts = function () {
    return requests.filter(function (request) {
        return request.method === 'POST' && request.url.indexOf('/api/missions') !== -1;
    }).length;
};

var uploadAndExpect = async function (page, label, names, hrefs) {
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
    await button.click({timeout: WAIT_TIMEOUT});

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

checks.push({name: 'mods', run: async function (page) {
    await clickNav(page, 'a#mods', '#mods');
    await rowWithText(page, '@smoke_mod').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await screenshotBoth(page, 'mods');
}});

checks.push({name: 'logs', run: async function (page) {
    await clickNav(page, 'a#logs', '#logs');
    await rowWithText(page, 'arma3server_smoke.log').waitFor({state: 'visible', timeout: WAIT_TIMEOUT});
    await screenshotBoth(page, 'logs');
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

    var dialog = page.locator('.sweet-alert.showSweetAlert');
    await dialog.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    var cancel = dialog.locator('button.cancel');
    await cancel.waitFor({state: 'visible', timeout: WAIT_TIMEOUT});

    await settle(page);
    await screenshot(page, 'op-mode-run-confirm');

    // Never the confirm button: that would stop servers.
    await cancel.click({timeout: WAIT_TIMEOUT});
    await page.locator('.sweet-alert').waitFor({state: 'hidden', timeout: WAIT_TIMEOUT});

    if (runPosts() !== before) {
        throw new Error('POST /api/op-mode/run was sent');
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
