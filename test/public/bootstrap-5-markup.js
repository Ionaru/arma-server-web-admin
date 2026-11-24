require('should');
var fs = require('fs');
var path = require('path');

// The frontend runs on Bootstrap 5 with the bootstrap-icons font and an in-repo modal. A leftover
// Bootstrap 3 class, data attribute or jQuery plugin call does not fail loudly: the class just
// renders unstyled, `data-toggle` does nothing and `$(el).tab()` is not a function only when it is
// clicked. This scan keeps Bootstrap 3 code (for instance ported from upstream) from coming back.
// Nothing is required or executed: templates, scripts and css are read as text, with their comments
// blanked out first (newlines kept, so a hit reports its real line).
describe('Bootstrap 5 markup and API usage in public/', function () {
    var rootDir = path.join(__dirname, '..', '..');
    var jsDir = path.join(rootDir, 'public', 'js');
    var tplDir = path.join(jsDir, 'tpl');

    var walk = function (dir, extension) {
        return fs.readdirSync(dir).reduce(function (files, entry) {
            var full = path.join(dir, entry);

            if (fs.statSync(full).isDirectory()) {
                return files.concat(walk(full, extension));
            }

            return path.extname(entry) === extension ? files.concat(full) : files;
        }, []);
    };

    var rel = function (file) {
        return path.relative(rootDir, file).split(path.sep).join('/');
    };

    var blank = function (match) {
        return match.replace(/[^\n]/g, ' ');
    };

    var stripHtml = function (text) {
        return text.replace(/<!--[\s\S]*?-->/g, blank);
    };

    var stripJs = function (text) {
        return text
            .replace(/\/\*[\s\S]*?\*\//g, blank)
            .replace(/(^|\s)\/\/.*$/gm, function (match, lead) {
                return lead + blank(match.slice(lead.length));
            });
    };

    var stripCss = function (text) {
        return text.replace(/\/\*[\s\S]*?\*\//g, blank);
    };

    var read = function (file, strip) {
        return strip(fs.readFileSync(file, 'utf8'));
    };

    var templates = walk(tplDir, '.html');
    var scripts = walk(jsDir, '.js');

    var lineOf = function (text, index) {
        return text.slice(0, index).split('\n').length;
    };

    // One entry per hit: "<file>:<line>: <what>".
    var scan = function (files, strip, collect) {
        var hits = [];

        files.forEach(function (file) {
            var text = read(file, strip);

            collect(text, function (index, what) {
                hits.push(rel(file) + ':' + lineOf(text, index) + ': ' + what);
            });
        });

        return hits;
    };

    var scanPattern = function (files, strip, pattern) {
        return scan(files, strip, function (text, report) {
            var regex = new RegExp(pattern.source, 'g' + (pattern.ignoreCase ? 'i' : ''));
            var match;

            while ((match = regex.exec(text)) !== null) {
                report(match.index, match[0].trim());
            }
        });
    };

    // Class names that exist in Bootstrap 3 only, or that Bootstrap 5 renamed.
    var BANNED_CLASSES = [
        /^btn-(default|xs)$/,
        /^label(-[a-z]+)?$/,
        /^pull-(left|right)$/,
        /^glyphicon(-[a-z0-9-]+)?$/,
        /^panel(-[a-z]+)?$/,
        /^navbar-(default|fixed-top|header|toggle|right)$/,
        /^(icon-bar|sr-only|caret|help-block|control-label|form-group|form-horizontal|form-control-static|checkbox|checkbox-inline|radio|text-muted)$/,
        /^col-(xs|sm|md|lg)-(push|pull|offset)-\d+$/
    ];

    var isBanned = function (token) {
        return BANNED_CLASSES.some(function (regex) {
            return regex.test(token);
        });
    };

    // The string literals of the bundled scripts that request Bootstrap itself (not its css).
    var bootstrapRequests = function (text) {
        var found = [];
        var regex = /(['"])(bootstrap(?:\/[^'"]*)?)\1/g;
        var match;

        while ((match = regex.exec(text)) !== null) {
            found.push({index: match.index, request: match[2]});
        }

        return found.filter(function (item) {
            return !/\.css$/.test(item.request);
        });
    };

    var BUNDLE = 'bootstrap/dist/js/bootstrap.bundle';

    it('should find some templates and scripts to check', function () {
        templates.length.should.be.above(0);
        scripts.length.should.be.above(0);
    });

    describe('M1 class names', function () {
        it('M1 should use no Bootstrap 3 class in a class attribute of a template or a script', function () {
            var attributes = function (text, report) {
                var regex = /\bclass\s*=\s*(["'])([\s\S]*?)\1/g;
                var match;

                while ((match = regex.exec(text)) !== null) {
                    // Template code inside the attribute is not a class name.
                    match[2].replace(/<%[\s\S]*?%>/g, ' ').split(/\s+/).forEach(function (token) {
                        if (token !== '' && isBanned(token)) {
                            report(match.index, token);
                        }
                    });
                }
            };

            scan(templates, stripHtml, attributes).should.eql([]);
            scan(scripts, stripJs, attributes).should.eql([]);
        });

        // Any quoted string may hold class names: a selector (`'.panel-body'`), a className, a
        // classList argument or a space-separated list. A token is a run of characters between
        // whitespace, commas, dots and hashes, so `input:checkbox` (a jQuery selector) is not `checkbox`.
        it('M1 should use no Bootstrap 3 class name in any quoted string of a script', function () {
            scan(scripts, stripJs, function (text, report) {
                var regex = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
                var match;

                while ((match = regex.exec(text)) !== null) {
                    match[2].split(/[\s,.#]+/).forEach(function (token) {
                        if (token !== '' && isBanned(token)) {
                            report(match.index, token);
                        }
                    });
                }
            }).should.eql([]);
        });
    });

    describe('M2 data attributes', function () {
        it('M2 should use data-bs-* attributes, never data-toggle, data-target or data-dismiss, in a template', function () {
            scanPattern(templates, stripHtml, /\bdata-(toggle|target|dismiss)\s*=/).should.eql([]);
        });

        // Markup built in a script (a string, setAttribute('data-toggle', ...)) is just as dead.
        it('M2 should use data-bs-* attributes, never data-toggle, data-target or data-dismiss, in a script', function () {
            scanPattern(scripts, stripJs, /\bdata-(toggle|target|dismiss)\s*=/).should.eql([]);
            scanPattern(scripts, stripJs, /['"]data-(toggle|target|dismiss)['"]/).should.eql([]);
        });
    });

    describe('M3 jQuery plugins and the old modal', function () {
        // window.jQuery is never set, so Bootstrap registers no jQuery plugin: `$(el).tab()` throws.
        it('M3 should not call the Bootstrap jQuery plugins or use the Bootstrap 3 events and data', function () {
            scanPattern(scripts, stripJs, /\.(tab|modal|dropdown|collapse|tooltip|popover)\(|focusin\.bs|data\(\s*['"]bs\./).should.eql([]);
        });

        it('M3 should not use backbone.bootstrap-modal', function () {
            scanPattern(scripts, stripJs, /BootstrapModal|backbone\.bootstrap-modal/).should.eql([]);
        });
    });

    describe('M4 Glyphicons', function () {
        it('M4 should not mention Glyphicons in a template, a script or the stylesheet', function () {
            var hits = scanPattern(templates, stripHtml, /glyphicon|halflings/i)
                .concat(scanPattern(scripts, stripJs, /glyphicon|halflings/i))
                .concat(scanPattern([path.join(rootDir, 'public', 'css', 'styles.css')], stripCss, /glyphicon|halflings/i));

            hits.should.eql([]);
        });
    });

    describe('M5 dependencies and requests', function () {
        var pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
        var all = Object.assign({}, pkg.dependencies, pkg.devDependencies);

        it('M5 should depend on Bootstrap 5.3 and bootstrap-icons, and not on backbone.bootstrap-modal', function () {
            all.should.have.property('bootstrap');
            all.bootstrap.should.match(/^[\^~]?5\.3\./);
            all.should.have.property('bootstrap-icons');
            all.should.not.have.property('backbone.bootstrap-modal');
        });

        it('M5 should request the Bootstrap script only as ' + BUNDLE, function () {
            var hits = scan(scripts, stripJs, function (text, report) {
                bootstrapRequests(text).forEach(function (item) {
                    if (item.request !== BUNDLE) {
                        report(item.index, item.request);
                    }
                });
            });

            hits.should.eql([]);
        });

        ['app.js', 'app/views/modal.js', 'app/views/navigation.js'].forEach(function (name) {
            it('M5 should have public/js/' + name + ' request ' + BUNDLE, function () {
                var file = path.join(jsDir, name);

                fs.existsSync(file).should.be.true();
                bootstrapRequests(read(file, stripJs)).map(function (item) {
                    return item.request;
                }).should.containEql(BUNDLE);
            });
        });

        it('M5 should have public/js/app.js load the Bootstrap and bootstrap-icons stylesheets', function () {
            var text = read(path.join(jsDir, 'app.js'), stripJs);

            text.should.match(/require\(\s*(['"])bootstrap\/dist\/css\/bootstrap\.css\1\s*\)/);
            text.should.match(/require\(\s*(['"])bootstrap-icons\/font\/bootstrap-icons\.css\1\s*\)/);
        });
    });

    describe('M6 modal view', function () {
        var modalFile = path.join(jsDir, 'app', 'views', 'modal.js');

        it('M6 should have an in-repo modal view with open, close and preventClose that triggers ok', function () {
            fs.existsSync(modalFile).should.be.true();

            var text = read(modalFile, stripJs);

            text.should.match(/\bopen\s*:\s*function|prototype\.open\s*=/);
            text.should.match(/\bclose\s*:\s*function|prototype\.close\s*=/);
            text.should.match(/\bpreventClose\s*:\s*function|prototype\.preventClose\s*=/);
            text.should.match(/\.trigger\(\s*['"]ok['"]/);
        });

        it('M6 should tear down on the native hidden.bs.modal event', function () {
            read(modalFile, stripJs).should.match(/addEventListener\(\s*['"]hidden\.bs\.modal['"]/);
        });

        it('M6 should leave sweetalert2 popup sizing to Bootstrap (no .swal2-popup rule in styles.css)', function () {
            scanPattern([path.join(rootDir, 'public', 'css', 'styles.css')], stripCss, /\.swal2-popup/).should.eql([]);
        });
    });

    describe('M7 active navigation item', function () {
        it('M7 should not put the active class on the server item of the dropdown through className', function () {
            var file = path.join(jsDir, 'app', 'views', 'navigation', 'servers', 'list_item.js');

            scanPattern([file], stripJs, /\bclassName\s*:/).should.eql([]);
        });

        it('M7 should put the active class of the navbar on its links, never on an li', function () {
            var file = path.join(tplDir, 'navigation.html');
            var text = read(file, stripHtml);

            scanPattern([file], stripHtml, /<li\b[^>]*isActiveRoute/).should.eql([]);

            var tagOf = function (index) {
                var regex = /<([a-z][a-z0-9]*)\b/g;
                var name = null;
                var match;

                while ((match = regex.exec(text)) !== null && match.index < index) {
                    name = match[1];
                }

                return name;
            };
            var sites = [];
            var regex = /isActiveRoute\(/g;
            var match;

            while ((match = regex.exec(text)) !== null) {
                sites.push(rel(file) + ':' + lineOf(text, match.index) + ': inside <' + tagOf(match.index) + '>');
            }

            sites.length.should.be.above(0);
            sites.filter(function (site) {
                return !/inside <a>$/.test(site);
            }).should.eql([]);
        });
    });

    describe('M8 commented-out buttons', function () {
        // The Delete and Clone buttons are disabled on purpose (see "Relationship to upstream" in
        // CLAUDE.md): they stay as comments, so changing their classes must not bring them back.
        var cases = [
            ['servers/list_item.html', ['clone', 'delete']],
            ['missions/list_item.html', ['delete']],
            ['mods/list_item.html', ['destroy']]
        ];

        cases.forEach(function (item) {
            var name = item[0];

            item[1].forEach(function (word) {
                it('M8 should keep the ' + word + ' button of ' + name + ' inside an HTML comment', function () {
                    var file = path.join(tplDir, name);
                    var raw = fs.readFileSync(file, 'utf8');
                    var comments = (raw.match(/<!--[\s\S]*?-->/g) || []).join('\n');
                    var wordPattern = new RegExp('\\b' + word + '\\b', 'i');

                    comments.should.match(new RegExp('<(button|a)\\b[^>]*\\b' + word + '\\b', 'i'));
                    scanPattern([file], stripHtml, wordPattern).should.eql([]);
                });
            });
        });
    });
});
