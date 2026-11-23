require('should');
var fs = require('fs');
var path = require('path');
var _ = require('underscore');

// There is no build step: view modules call _.template(tpl) at load time, so a template is only
// compiled when it first runs in someone's browser. An unsupported delimiter (e.g. the EJS comment
// form <%# %>, which Underscore reads as a <% %> evaluate block and emits as raw JS) therefore
// surfaces as an Uncaught SyntaxError in the console with nothing to catch it, rather than as a
// failed build. Compile every template here so that class of mistake fails the suite instead.
describe('public templates', function () {
    var tplDir = path.join(__dirname, '..', '..', 'public', 'js', 'tpl');

    var htmlFiles = function (dir) {
        return fs.readdirSync(dir).reduce(function (files, entry) {
            var full = path.join(dir, entry);

            if (fs.statSync(full).isDirectory()) {
                return files.concat(htmlFiles(full));
            }

            return /\.html$/.test(entry) ? files.concat(full) : files;
        }, []);
    };

    var templates = htmlFiles(tplDir);

    it('should find some templates to check', function () {
        templates.length.should.be.above(0);
    });

    templates.forEach(function (file) {
        it('should compile ' + path.relative(tplDir, file) + ' with underscore', function () {
            var tpl = fs.readFileSync(file, 'utf8');

            // _.template compiles immediately (it builds the render function), so an unsupported
            // delimiter throws here, exactly as it would in the browser.
            _.template.bind(_, tpl).should.not.throw();
        });
    });
});

describe('B7 players template', function () {
    var tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'tpl', 'servers', 'players.html'), 'utf8');

    // Same data the Players view passes: the model's attributes plus a players() helper that
    // sorts state.players by name (public/js/app/views/servers/players.js).
    var render = function (state) {
        return _.template(tpl)({
            state: state,
            players: function () {
                return _.sortBy(state.players, function (player) {
                    return player.name;
                });
            }
        });
    };

    it('B7 should print names and scores read from player.raw.score', function () {
        var html = render({
            name: 'Op',
            map: 'Altis',
            maxplayers: 40,
            players: [
                {name: 'Alice', raw: {score: 12, time: 30}},
                {name: 'Bob', raw: {score: 0, time: 5}}
            ],
            raw: {game: 'Co40 Op'}
        });

        html.should.containEql('Alice');
        html.should.containEql('12');
        html.should.containEql('Bob');
        html.should.match(/<td>\s*0\s*<\/td>/);
        html.should.not.containEql('undefined');
    });
});

describe('B1-B3 template escaping of game query data', function () {
    var tplDir = path.join(__dirname, '..', '..', 'public', 'js', 'tpl');
    var EVIL = '<img src=x onerror=alert(1)>';
    var ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

    var read = function (name) {
        return fs.readFileSync(path.join(tplDir, name), 'utf8');
    };

    var countOf = function (html, needle) {
        return html.split(needle).length - 1;
    };

    describe('B1 players template', function () {
        var tpl = read(path.join('servers', 'players.html'));

        it('B1 should escape markup in a player name and still print the score', function () {
            var state = {
                players: [{name: EVIL, raw: {score: 3, time: 1}}]
            };
            var html = _.template(tpl)({
                state: state,
                players: function () {
                    return state.players;
                }
            });

            html.should.containEql(ESCAPED);
            html.should.not.containEql('<img');
            html.should.match(/<td>\s*3\s*<\/td>/);
        });
    });

    describe('B2 info template', function () {
        var tpl = read(path.join('servers', 'info.html'));

        it('B2 should escape markup in name, map and mission and still print the player count', function () {
            var html = _.template(tpl)({
                port: 2302,
                mods: [],
                pid: 1234,
                state: {
                    name: EVIL,
                    map: EVIL,
                    raw: {game: EVIL},
                    players: [],
                    maxplayers: 40
                }
            });

            countOf(html, ESCAPED).should.equal(3);
            html.should.not.containEql('<img');
            html.should.match(/0\s*\/\s*40/);
        });
    });

    describe('B3 no raw data sites left', function () {
        // The only <%= sites that remain: markup the code builds itself.
        var allowed = {
            'navigation.html': 5,
            'servers/form.html': 1
        };

        var htmlFiles = function (dir) {
            return fs.readdirSync(dir).reduce(function (files, entry) {
                var full = path.join(dir, entry);

                if (fs.statSync(full).isDirectory()) {
                    return files.concat(htmlFiles(full));
                }

                return /\.html$/.test(entry) ? files.concat(full) : files;
            }, []);
        };

        it('B3 should find <%= only in the allowed templates', function () {
            var unexpected = [];

            htmlFiles(tplDir).forEach(function (file) {
                var rel = path.relative(tplDir, file).split(path.sep).join('/');
                var hits = [];

                fs.readFileSync(file, 'utf8').split('\n').forEach(function (line, index) {
                    if (line.indexOf('<%=') !== -1) {
                        hits.push(rel + ':' + (index + 1) + ': ' + line.trim());
                    }
                });

                if (hits.length > (allowed[rel] || 0)) {
                    unexpected = unexpected.concat(hits);
                }
            });

            unexpected.should.eql([]);
        });

        it('B3 should still find the allowed sites (the allow-list is current)', function () {
            Object.keys(allowed).forEach(function (rel) {
                countOf(read(rel), '<%=').should.equal(allowed[rel]);
            });
        });
    });
});
