require('should');
var fs = require('fs');
var path = require('path');

// The frontend runs on Marionette 4, where the Marionette 2 API does not fail loudly: a missing
// ItemView is a TypeError only when the module loads, but `templateHelpers` is silently ignored,
// a `filter:` key replaces the CollectionView.filter() method (render() then throws), and
// `view.isDestroyed` without the call is a function and therefore always truthy. This scan keeps
// code written for Marionette 2 (for instance ported from upstream) from coming back. Nothing is
// required or executed: every .js file under public/js is read as text.
describe('Marionette 4 API usage in public/js', function () {
    var jsDir = path.join(__dirname, '..', '..', 'public', 'js');
    var viewsDir = path.join(jsDir, 'app', 'views');

    var jsFiles = function (dir) {
        return fs.readdirSync(dir).reduce(function (files, entry) {
            var full = path.join(dir, entry);

            if (fs.statSync(full).isDirectory()) {
                return files.concat(jsFiles(full));
            }

            return /\.js$/.test(entry) ? files.concat(full) : files;
        }, []);
    };

    var files = jsFiles(jsDir);

    var rel = function (file) {
        return 'public/js/' + path.relative(jsDir, file).split(path.sep).join('/');
    };

    // One entry per offending line: "<file>:<line>: <trimmed line>".
    var findLines = function (fileList, test) {
        var hits = [];

        fileList.forEach(function (file) {
            fs.readFileSync(file, 'utf8').split('\n').forEach(function (line, index) {
                if (test(line)) {
                    hits.push(rel(file) + ':' + (index + 1) + ': ' + line.trim());
                }
            });
        });

        return hits;
    };

    it('should find some files to check', function () {
        files.length.should.be.above(0);
        files.filter(function (file) {
            return file.indexOf(viewsDir + path.sep) === 0;
        }).length.should.be.above(0);
    });

    it('B11a should not use Marionette.ItemView, Marionette.LayoutView or Marionette.CompositeView', function () {
        findLines(files, function (line) {
            return /Marionette\.(ItemView|LayoutView|CompositeView)/.test(line);
        }).should.eql([]);
    });

    it('B11b should not use templateHelpers (Marionette 4 ignores it silently, use templateContext)', function () {
        findLines(files, function (line) {
            return line.indexOf('templateHelpers') !== -1;
        }).should.eql([]);
    });

    it('B11c should not have an object key named filter in a view (use viewFilter)', function () {
        var viewFiles = files.filter(function (file) {
            return file.indexOf(viewsDir + path.sep) === 0;
        });

        findLines(viewFiles, function (line) {
            return /^\s*filter\s*:/.test(line);
        }).should.eql([]);
    });

    it('B11d should call isDestroyed, isRendered and isAttached (they are methods)', function () {
        findLines(files, function (line) {
            return /\b(isDestroyed|isRendered|isAttached)\b(?!\s*\()/.test(line);
        }).should.eql([]);
    });

    it('B11e should extend app/views/collection-view.js instead of Marionette.CollectionView in every list view', function () {
        var shared = path.join(viewsDir, 'collection-view.js');

        findLines(files.filter(function (file) {
            return file !== shared;
        }), function (line) {
            return line.indexOf('Marionette.CollectionView.extend') !== -1;
        }).should.eql([]);
    });
});
