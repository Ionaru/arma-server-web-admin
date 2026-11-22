require('should');

var profiles = require('../../lib/profiles.js');

describe('profiles', function () {
    describe('profilesPath() (B1)', function () {
        var cases = [
            [['-profiles=C:\\Arma\\P'], 'C:\\Arma\\P'],
            [['-profiles="C:\\Arma\\P\\"'], 'C:\\Arma\\P\\'],
            [['"-profiles=C:\\My Dir\\P"'], 'C:\\My Dir\\P'],
            [['-Profiles=/srv/p'], '/srv/p'],
            [['  -PROFILES=/srv/p  '], '/srv/p'],
            [['-noSound', '-profiles=/a', '-name=7R', '-profiles=/b'], '/b'],
            [['-profiles=/a', '-profiles='], null],
            [['-profiles=""'], null],
            [['-name=7R', '-profilesX=/a', '-profiles'], null],
            [[], null],
            [null, null],
            [undefined, null],
            [[42, null, '-profiles=/a'], '/a']
        ];

        cases.forEach(function (c) {
            it('should map ' + JSON.stringify(c[0]) + ' to ' + JSON.stringify(c[1]), function () {
                var result = profiles.profilesPath(c[0]);
                (result === c[1]).should.be.true();
            });
        });
    });

    describe('withoutProfiles() (B2)', function () {
        it('should remove every profiles parameter and keep the order of the rest', function () {
            profiles.withoutProfiles(['-noSound', '-profiles=C:\\P', '-name=7R', '"-Profiles=/b"'])
                .should.eql(['-noSound', '-name=7R']);
        });

        it('should return a different array instance and not mutate the input', function () {
            var input = ['-noSound'];
            var result = profiles.withoutProfiles(input);

            result.should.eql(['-noSound']);
            (result === input).should.be.false();

            var input2 = ['-noSound', '-profiles=/a'];
            profiles.withoutProfiles(input2);
            input2.should.eql(['-noSound', '-profiles=/a']);
        });

        it('should remove empty valued profiles parameters', function () {
            profiles.withoutProfiles(['-profiles=']).should.eql([]);
        });

        it('should return an empty array for null and undefined', function () {
            profiles.withoutProfiles(null).should.eql([]);
            profiles.withoutProfiles(undefined).should.eql([]);
        });
    });

    describe('childPath() (B3)', function () {
        var cases = [
            ['C:\\Arma\\P\\', 'HC_0', 'windows', 'C:\\Arma\\P\\HC_0'],
            ['C:\\Arma\\P', 'HC_1', 'windows', 'C:\\Arma\\P\\HC_1'],
            ['C:/Arma/P', 'HC_0', 'windows', 'C:/Arma/P/HC_0'],
            ['/srv/p/', 'HC_0', 'linux', '/srv/p/HC_0'],
            ['profiles', 'HC_0', 'windows', 'profiles\\HC_0'],
            ['profiles', 'HC_0', 'wine', 'profiles\\HC_0'],
            ['profiles', 'HC_0', 'linux', 'profiles/HC_0'],
            ['C:\\', 'HC_0', 'windows', 'C:\\HC_0'],
            ['/', 'HC_0', 'linux', '/HC_0']
        ];

        cases.forEach(function (c) {
            it('should join ' + JSON.stringify(c[0]) + ' (' + c[2] + ') to ' + JSON.stringify(c[3]), function () {
                profiles.childPath(c[0], c[1], c[2]).should.eql(c[3]);
            });
        });
    });
});
