require('should');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');
var tk = require('timekeeper');
var userhome = require('userhome');

var Logs = require('../../lib/logs.js');
var logs = new Logs({
    path: '/tmp/',
    type: 'linux'
});

describe('Logs', function () {
    beforeEach(function () {
        tk.freeze(1445455712000); // 2015-10-21 19:28:32
    });

    afterEach(function () {
        tk.reset();
    });

    describe('generateLogFileName()', function () {
        it('should generate valid file name', function () {
            Logs.generateLogFileName().should.eql('arma3server_2015-10-21_19-28-32.log');
        });

        it('should append a suffix before the extension (B4)', function () {
            Logs.generateLogFileName('HC_0').should.eql('arma3server_2015-10-21_19-28-32_HC_0.log');
        });
    });

    describe('generateLogFilePath()', function () {
        it('should generate valid file path', function () {
            logs.generateLogFilePath().should.eql('/tmp/logs/arma3server_2015-10-21_19-28-32.log');
        });

        it('should pass the suffix through (B5)', function () {
            logs.generateLogFilePath('HC_2').should.eql('/tmp/logs/arma3server_2015-10-21_19-28-32_HC_2.log');
        });
    });
});

describe('Logs listing', function () {
    var root;
    var armaPath;

    var fakeServer = function (title, parameters) {
        return {
            title: title,
            getParameters: function () {
                return parameters;
            }
        };
    };

    var makeLogs = function (servers, type, game) {
        var instance = new Logs({path: armaPath, type: type || 'linux', game: game || 'arma3'});

        if (servers) {
            instance.setServers(function () {
                return servers;
            });
        }

        return instance;
    };

    var write = function (relative, content) {
        var full = path.join(root, relative);
        fs.mkdirSync(path.dirname(full), {recursive: true});
        fs.writeFileSync(full, content === undefined ? 'content' : content);
        return full;
    };

    var idOf = function (fullPath) {
        return crypto.createHash('sha1').update(fullPath).digest('hex').slice(0, 12) + '-' + path.basename(fullPath);
    };

    var names = function (files) {
        return files.map(function (file) {
            return file.name;
        });
    };

    var byName = function (files, name) {
        return files.filter(function (file) {
            return file.name === name;
        })[0];
    };

    beforeEach(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-listing-'));
        armaPath = path.join(root, 'arma');
        fs.mkdirSync(path.join(armaPath, 'logs'), {recursive: true});
    });

    afterEach(function () {
        fs.rmSync(root, {recursive: true, force: true});
    });

    describe('logDirectories() (B1, B2)', function () {
        it('B1: should have no servers before setServers is called', function () {
            makeLogs().logDirectories().should.eql([
                {path: path.join(armaPath, 'logs'), kind: 'default', servers: []}
            ]);
        });

        it('B1: should treat a getServers returning undefined as no servers', function () {
            var instance = makeLogs();
            instance.setServers(function () {
                return undefined;
            });

            instance.logDirectories().should.eql([
                {path: path.join(armaPath, 'logs'), kind: 'default', servers: []}
            ]);
        });

        it('B2: should return only the default entry without servers', function () {
            makeLogs([]).logDirectories().should.eql([
                {path: path.join(armaPath, 'logs'), kind: 'default', servers: []}
            ]);
        });

        it('B2: should merge servers sharing a folder and still add the default entry for a server without profiles', function () {
            var a = path.join(root, 'p', 'a');
            var servers = [
                fakeServer('A', ['-profiles=' + a]),
                fakeServer('B', ['-noSound', '-profiles=' + a + path.sep]),
                fakeServer('C', ['-name=x'])
            ];

            makeLogs(servers).logDirectories().should.eql([
                {path: a, kind: 'profiles', servers: ['A', 'B']},
                {path: path.join(armaPath, 'logs'), kind: 'default', servers: []}
            ]);
        });

        it('B2: should resolve a relative profiles path against the Arma install folder', function () {
            makeLogs([fakeServer('A', ['-profiles=profiles'])]).logDirectories().should.eql([
                {path: path.join(armaPath, 'profiles'), kind: 'profiles', servers: ['A']},
                {path: path.join(armaPath, 'logs'), kind: 'default', servers: []}
            ]);
        });

        it('B2: should drop the default entry when a profile entry already has its path', function () {
            var logsDir = path.join(armaPath, 'logs');

            makeLogs([fakeServer('A', ['-profiles=' + logsDir])]).logDirectories().should.eql([
                {path: logsDir, kind: 'profiles', servers: ['A']}
            ]);
        });

        it('B2: should keep first-appearance order of profile entries', function () {
            var servers = [
                fakeServer('A', ['-profiles=' + path.join(root, 'p', 'b')]),
                fakeServer('B', ['-profiles=' + path.join(root, 'p', 'a')]),
                fakeServer('C', ['-profiles=' + path.join(root, 'p', 'b')])
            ];
            var dirs = makeLogs(servers).logDirectories();

            dirs[0].should.eql({path: path.join(root, 'p', 'b'), kind: 'profiles', servers: ['A', 'C']});
            dirs[1].should.eql({path: path.join(root, 'p', 'a'), kind: 'profiles', servers: ['B']});
        });

        if (process.platform !== 'win32') {
            it('B2: should compare paths case-sensitively on a non-win32 host', function () {
                var servers = [
                    fakeServer('A', ['-profiles=' + path.join(root, 'p', 'a')]),
                    fakeServer('B', ['-profiles=' + path.join(root, 'p', 'A')])
                ];
                var dirs = makeLogs(servers).logDirectories();

                dirs.length.should.eql(3);
                dirs[0].servers.should.eql(['A']);
                dirs[1].servers.should.eql(['B']);
            });
        }

        it('B2: should add no default entry on windows when every server has profiles', function () {
            var servers = [
                fakeServer('A', ['-profiles=' + path.join(root, 'p', 'a')]),
                fakeServer('B', ['-profiles=' + path.join(root, 'p', 'b')])
            ];

            makeLogs(servers, 'windows').logDirectories().should.eql([
                {path: path.join(root, 'p', 'a'), kind: 'profiles', servers: ['A']},
                {path: path.join(root, 'p', 'b'), kind: 'profiles', servers: ['B']}
            ]);
        });

        it('B2: should add the default entry on windows when a server has no profiles', function () {
            var servers = [
                fakeServer('A', ['-profiles=' + path.join(root, 'p', 'a')]),
                fakeServer('B', [])
            ];

            makeLogs(servers, 'windows').logDirectories().should.eql([
                {path: path.join(root, 'p', 'a'), kind: 'profiles', servers: ['A']},
                {path: path.resolve(userhome('AppData', 'Local', 'Arma 3')), kind: 'default', servers: []}
            ]);
        });

        it('B2: should return an empty list when the game has no logs folder', function () {
            makeLogs([fakeServer('B', [])], 'windows', 'nope').logDirectories().should.eql([]);
        });
    });

    describe('wine profile paths (R2)', function () {
        var origHome;
        var home;
        var wineCfg = {path: '/T/arma', type: 'wine', game: 'arma3'};

        beforeEach(function () {
            origHome = process.env.HOME;
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-home-'));
            process.env.HOME = home;
        });

        afterEach(function () {
            if (origHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = origHome;
            }
            fs.rmSync(home, {recursive: true, force: true});
        });

        var dirsFor = function (parameters) {
            var instance = new Logs(wineCfg);
            instance.setServers(function () {
                return [fakeServer('A', parameters)];
            });
            return instance.logDirectories();
        };

        var H = function () {
            return userhome('.wine');
        };

        it('R2: should map a Windows drive path into the wine prefix and keep the default entry', function () {
            var D = path.resolve(new Logs(wineCfg).logsPath());

            dirsFor(['-profiles=C:\\Arma\\P\\']).should.eql([
                {path: path.join(H(), 'dosdevices', 'c:', 'Arma', 'P'), kind: 'profiles', servers: ['A']},
                {path: D, kind: 'default', servers: []}
            ]);
        });

        it('R2: should map a forward-slash drive path and lowercase the drive letter', function () {
            dirsFor(['-profiles=Z:/srv/p'])[0].path.should.eql(path.join(H(), 'dosdevices', 'z:', 'srv', 'p'));
        });

        it('R2: should map a bare drive root to the drive entry', function () {
            dirsFor(['-profiles=C:\\'])[0].path.should.eql(path.join(H(), 'dosdevices', 'c:'));
        });

        it('R2: should resolve a relative backslash path against the Arma install folder', function () {
            dirsFor(['-profiles=profiles\\op'])[0].path.should.eql('/T/arma/profiles/op');
        });

        it('R2: should keep an absolute unix path as is', function () {
            dirsFor(['-profiles=/srv/p'])[0].path.should.eql('/srv/p');
        });

        it('R2: should list files of a mapped folder and its HC_<n> subfolders', function (done) {
            var mapped = path.join(home, '.wine', 'dosdevices', 'c:', 'Arma', 'P');
            fs.mkdirSync(path.join(mapped, 'HC_0'), {recursive: true});
            fs.writeFileSync(path.join(mapped, 'a.rpt'), 'x');
            fs.writeFileSync(path.join(mapped, 'HC_0', 'b.rpt'), 'x');

            var instance = new Logs(wineCfg);
            instance.setServers(function () {
                return [fakeServer('A', ['-profiles=C:\\Arma\\P'])];
            });

            instance.logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).sort().should.eql(['a.rpt', 'b.rpt']);
                byName(files, 'b.rpt').role.should.eql('HC_0');
                done();
            });
        });
    });

    describe('logFiles() listing (B3, B4)', function () {
        var listProfiles = function (servers, cb) {
            makeLogs(servers).logFiles(cb);
        };

        it('B3: should list a profiles-folder rpt that the default folder does not hold (reproduction)', function (done) {
            var name = 'arma3server_x64_2026-11-21_19-30-10.rpt';
            write(path.join('p', 'a', name));

            listProfiles([fakeServer('A', ['-profiles=' + path.join(root, 'p', 'a')])], function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).should.eql([name]);
                done();
            });
        });

        it('B3: should list only log-like files and HC_<n> subfolders of a profiles folder', function (done) {
            var a = path.join(root, 'p', 'a');
            write('p/a/x.rpt');
            write('p/a/y.LOG');
            write('p/a/z.mdmp');
            write('p/a/w.bidmp');
            write('p/a/upper.RPT');
            write('p/a/server.cfg');
            write('p/a/Users/x/x.Arma3Profile');
            write('p/a/hc_0/lower.rpt');
            write('p/a/HC_0/hc0.rpt');
            write('p/a/HC_0/DataCache/deep.rpt');
            write('p/a/HC_0/notes.txt');
            write('p/a/HC_12/hc12.log');
            write('p/a/HC_x/nonnumeric.rpt');
            fs.mkdirSync(path.join(a, 'dir.rpt'), {recursive: true});

            listProfiles([fakeServer('A', ['-profiles=' + a])], function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).sort().should.eql([
                    'hc0.rpt', 'hc12.log', 'upper.RPT', 'w.bidmp', 'x.rpt', 'y.LOG', 'z.mdmp'
                ].sort());
                done();
            });
        });

        it('B3: should list every regular file of the default folder, without subdirectories', function (done) {
            write('arma/logs/a.log');
            write('arma/logs/b.txt');
            write('arma/logs/sub/c.rpt');

            makeLogs([]).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).should.eql(['a.log', 'b.txt']);
                done();
            });
        });

        it('B3: should skip a missing directory instead of failing', function (done) {
            write('p/a/x.rpt');
            var servers = [
                fakeServer('A', ['-profiles=' + path.join(root, 'p', 'a')]),
                fakeServer('B', ['-profiles=' + path.join(root, 'missing')])
            ];
            fs.rmSync(path.join(armaPath, 'logs'), {recursive: true, force: true});

            listProfiles(servers, function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).should.eql(['x.rpt']);
                done();
            });
        });

        it('B3: should omit a file whose stat fails', function (done) {
            var a = path.join(root, 'p', 'a');
            write('p/a/good.rpt');
            fs.symlinkSync(path.join(root, 'nowhere'), path.join(a, 'broken.rpt'));

            listProfiles([fakeServer('A', ['-profiles=' + a])], function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).should.eql(['good.rpt']);
                done();
            });
        });

        it('B4: should describe each file with id, name, path, size, formattedSize and servers', function (done) {
            var a = path.join(root, 'p', 'a');
            var full = write('p/a/x.rpt', '12345');
            write('p/a/HC_0/h.rpt', '1');
            var servers = [fakeServer('A', ['-profiles=' + a]), fakeServer('B', ['-profiles=' + a])];

            listProfiles(servers, function (err, files) {
                if (err) {
                    return done(err);
                }

                var file = byName(files, 'x.rpt');
                file.id.should.eql(idOf(full));
                file.name.should.eql('x.rpt');
                file.path.should.eql(full);
                file.size.should.eql(5);
                file.formattedSize.should.eql('5 B');
                file.servers.should.eql(['A', 'B']);

                var hc = byName(files, 'h.rpt');
                hc.path.should.eql(path.join(a, 'HC_0', 'h.rpt'));
                hc.servers.should.eql(['A', 'B']);
                done();
            });
        });

        it('B4: should give default-folder files an empty servers list', function (done) {
            write('arma/logs/a.log');

            makeLogs([]).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                files[0].servers.should.eql([]);
                done();
            });
        });

        it('B4: should give the same file the same id on every call and different ids for the same name in two folders', function (done) {
            var servers = [
                fakeServer('A', ['-profiles=' + path.join(root, 'p', 'a')]),
                fakeServer('B', ['-profiles=' + path.join(root, 'p', 'b')])
            ];
            write('p/a/same.rpt');
            write('p/b/same.rpt');
            var instance = makeLogs(servers);

            instance.logFiles(function (err, first) {
                if (err) {
                    return done(err);
                }

                instance.logFiles(function (err, second) {
                    if (err) {
                        return done(err);
                    }

                    first.length.should.eql(2);
                    first.map(function (f) { return f.id; }).sort().should.eql(second.map(function (f) { return f.id; }).sort());
                    first[0].id.should.not.eql(first[1].id);
                    first.map(function (f) { return f.id; }).sort().should.eql([
                        idOf(path.join(root, 'p', 'a', 'same.rpt')),
                        idOf(path.join(root, 'p', 'b', 'same.rpt'))
                    ].sort());
                    done();
                });
            });
        });
    });

    describe('role (B5)', function () {
        var A_DIR;
        var roleOf = function (servers, name, cb) {
            makeLogs(servers).logFiles(function (err, files) {
                if (err) {
                    return cb(err);
                }

                cb(null, byName(files, name).role);
            });
        };

        var serverHeader = '====\n== C:\\Arma\\arma3server_x64.exe\n== arma3server_x64.exe -port=2302 "-config=configs\\op.cfg" -profiles=C:\\Arma\\P -name=7R -mod=@ace-client\n====\n';
        var hcLine = '== arma3server_x64.exe -connect=127.0.0.1 -profiles="C:\\Arma\\P\\" -name=7R -port=2302 -filePatching ';

        beforeEach(function () {
            A_DIR = path.join(root, 'p', 'a');
        });

        var expectRpt = function (content, expected, done) {
            write('p/a/x.rpt', content);

            roleOf([fakeServer('A', ['-profiles=' + A_DIR])], 'x.rpt', function (err, role) {
                if (err) {
                    return done(err);
                }

                (role === expected).should.be.true('expected ' + expected + ' but got ' + role);
                done();
            });
        };

        it('B5: should label an rpt without a -client argument as server (@ace-client is not -client)', function (done) {
            expectRpt(serverHeader, 'server', done);
        });

        it('B5: should label an rpt whose header has -client as HC', function (done) {
            expectRpt('====\n' + hcLine + '-client\n====\n', 'HC', done);
        });

        it('B5: should detect -client before a CRLF line end', function (done) {
            expectRpt('====\r\n' + hcLine + '-client\r\n====\r\n', 'HC', done);
        });

        it('B5: should detect a quoted "-client"', function (done) {
            expectRpt('====\n' + hcLine + '"-client"\n====\n', 'HC', done);
        });

        var longMods = new Array(201).join('C:\\Arma\\Game\\mods\\@some_long_mod_name;');
        var longLine = function (tail) {
            return '====\n== arma3server_x64.exe -connect=127.0.0.1 -mod=' + longMods + ' -port=2302' + tail + '\n====\n';
        };

        it('R1: should find -client after a very long -mod= list', function (done) {
            longMods.length.should.eql(7600);
            expectRpt(longLine(' -client'), 'HC', done);
        });

        it('R1: should label the same long header without -client as server', function (done) {
            expectRpt(longLine(''), 'server', done);
        });

        it('R1: should find -client after 5000 characters on the first line', function (done) {
            expectRpt(new Array(5001).join('x') + ' -client\n', 'HC', done);
        });

        it('R1: should only search the first 10 lines', function (done) {
            expectRpt(new Array(11).join('log line\n') + ' -client\n', 'server', done);
        });

        it('R1: should find -client on the 10th line', function (done) {
            expectRpt(new Array(10).join('log line\n') + ' -client\n', 'HC', done);
        });

        it('R1: should not read beyond 65536 bytes', function (done) {
            expectRpt(new Array(70001).join('x') + ' -client\n', 'server', done);
        });

        it('B5: should give an empty rpt a null role', function (done) {
            expectRpt('', null, done);
        });

        it('B5: should detect the rpt role case-insensitively on the extension', function (done) {
            write('p/a/Y.RPT', '====\n' + hcLine + '-client\n');

            roleOf([fakeServer('A', ['-profiles=' + A_DIR])], 'Y.RPT', function (err, role) {
                if (err) {
                    return done(err);
                }

                role.should.eql('HC');
                done();
            });
        });

        it('B5: should label a file in an HC_<n> subfolder with the subfolder name, whatever its header says', function (done) {
            write('p/a/HC_0/a.rpt', serverHeader);
            write('p/a/HC_12/b.log', 'anything');

            makeLogs([fakeServer('A', ['-profiles=' + A_DIR])]).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                byName(files, 'a.rpt').role.should.eql('HC_0');
                byName(files, 'b.log').role.should.eql('HC_12');
                done();
            });
        });

        it('B5: should label default-folder logs on linux by their HC suffix', function (done) {
            write('arma/logs/arma3server_2026-11-21_19-30-10.log');
            write('arma/logs/arma3server_2026-11-21_19-30-15_HC_1.log');
            write('arma/logs/notes.txt');
            write('arma/logs/crash.mdmp');

            makeLogs([]).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                byName(files, 'arma3server_2026-11-21_19-30-10.log').role.should.eql('server');
                byName(files, 'arma3server_2026-11-21_19-30-15_HC_1.log').role.should.eql('HC_1');
                (byName(files, 'notes.txt').role === null).should.be.true();
                (byName(files, 'crash.mdmp').role === null).should.be.true();
                done();
            });
        });

        it('B5: should label an rpt in the linux default folder by its header', function (done) {
            write('arma/logs/x.rpt', '====\n' + hcLine + '-client\n');

            makeLogs([]).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                files[0].role.should.eql('HC');
                done();
            });
        });

        it('B5: should give null for a log, mdmp or bidmp in a profiles folder', function (done) {
            write('p/a/a.log', 'x');
            write('p/a/b.mdmp', 'x');
            write('p/a/c.bidmp', 'x');

            makeLogs([fakeServer('A', ['-profiles=' + A_DIR])]).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                files.length.should.eql(3);
                files.forEach(function (file) {
                    (file.role === null).should.be.true(file.name + ' should have a null role');
                });
                done();
            });
        });
    });

    describe('order (B6)', function () {
        it('B6: should sort by lowercased name', function (done) {
            write('arma/logs/Banana.log');
            write('arma/logs/apple.log');
            write('arma/logs/Cherry.log');

            makeLogs([]).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).should.eql(['apple.log', 'Banana.log', 'Cherry.log']);
                done();
            });
        });

        it('B6: should order equal names by ascending id', function (done) {
            write('p/a/same.rpt');
            write('p/b/same.rpt');
            write('p/c/same.rpt');
            write('p/a/after.rpt');
            var servers = ['a', 'b', 'c'].map(function (n) {
                return fakeServer(n, ['-profiles=' + path.join(root, 'p', n)]);
            });

            makeLogs(servers).logFiles(function (err, files) {
                if (err) {
                    return done(err);
                }

                names(files).should.eql(['after.rpt', 'same.rpt', 'same.rpt', 'same.rpt']);
                var ids = files.slice(1).map(function (f) { return f.id; });
                ids.should.eql(ids.slice().sort());
                done();
            });
        });
    });

    describe('getLogFile() and delete() by id (B7)', function () {
        var servers;

        beforeEach(function () {
            servers = [
                fakeServer('A', ['-profiles=' + path.join(root, 'p', 'a')]),
                fakeServer('B', ['-profiles=' + path.join(root, 'p', 'b')])
            ];
        });

        it('B7: should find a file by id', function (done) {
            var full = write('p/a/x.rpt');

            makeLogs(servers).getLogFile(idOf(full), function (err, file) {
                if (err) {
                    return done(err);
                }

                file.path.should.eql(full);
                done();
            });
        });

        it('B7: should call back null for an unknown id', function (done) {
            write('p/a/x.rpt');

            makeLogs(servers).getLogFile('000000000000-x.rpt', function (err, file) {
                if (err) {
                    return done(err);
                }

                (file === null).should.be.true();
                done();
            });
        });

        it('B7: should never match a bare file name', function (done) {
            write('p/a/x.rpt');

            makeLogs(servers).getLogFile('x.rpt', function (err, file) {
                if (err) {
                    return done(err);
                }

                (file === null).should.be.true();
                done();
            });
        });

        it('B7: should delete only the file with the given id when two folders hold the same name', function (done) {
            var first = write('p/a/same.rpt');
            var second = write('p/b/same.rpt');

            makeLogs(servers).delete(idOf(first), function (err) {
                if (err) {
                    return done(err);
                }

                fs.existsSync(first).should.be.false();
                fs.existsSync(second).should.be.true();
                done();
            });
        });

        it('B7: should call back with File not found for an unknown id', function (done) {
            write('p/a/x.rpt');

            makeLogs(servers).delete('x.rpt', function (err) {
                err.should.be.an.Error();
                err.message.should.eql('File not found');
                fs.existsSync(path.join(root, 'p', 'a', 'x.rpt')).should.be.true();
                done();
            });
        });
    });
});

describe('Logs constructor log folder (B5)', function () {
    var tmp;

    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-ctor-'));
    });

    afterEach(function () {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('B5: should create the logs folder asynchronously on linux', function (done) {
        var logs = new Logs({path: tmp, type: 'linux', game: 'arma3'});
        var target = logs.logsPath();
        var started = Date.now();

        (function poll() {
            if (fs.existsSync(target)) {
                fs.statSync(target).isDirectory().should.be.true();
                return done();
            }

            if (Date.now() - started > 1000) {
                return done(new Error('logs folder ' + target + ' was not created within 1 s'));
            }

            setTimeout(poll, 10);
        })();
    });

    it('B5: should create nothing under the path on windows', function (done) {
        new Logs({path: tmp, type: 'windows', game: 'arma3'});

        setTimeout(function () {
            fs.readdirSync(tmp).should.eql([]);
            done();
        }, 100);
    });
});
