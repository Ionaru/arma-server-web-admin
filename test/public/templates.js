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
