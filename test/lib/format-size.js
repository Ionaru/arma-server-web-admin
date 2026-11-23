require('should');

var formatSize = require('../../lib/format-size.js');

describe('formatSize', function () {
    var cases = [
        [0, '0 B'],
        [1, '1 B'],
        [1023, '1023 B'],
        [1024, '1 KB'],
        [1536, '1.5 KB'],
        [123456, '120.56 KB'],
        [1048576, '1 MB'],
        [5368709120, '5 GB']
    ];

    cases.forEach(function (c) {
        it('B1: should format ' + c[0] + ' bytes as ' + c[1], function () {
            formatSize(c[0]).should.equal(c[1]);
        });
    });
});
