require('should');

var runDiscordTest = require('../../public/js/app/views/discord-test.js');

// The hooks the op-mode view supplies to runDiscordTest. Defaults describe a healthy, immediately
// successful request; each test overrides only what it needs and inspects the recorded calls.
var hooksWith = function (overrides) {
    var calls = {busy: [], requested: 0, success: 0, error: 0};

    var hooks = {
        isBusy: function () {
            return false;
        },
        setBusy: function (busy) {
            calls.busy.push(busy);
        },
        request: function (cb) {
            calls.requested++;
            cb(null);
        },
        onSuccess: function () {
            calls.success++;
        },
        onError: function () {
            calls.error++;
        }
    };

    overrides = overrides || {};
    Object.keys(overrides).forEach(function (key) {
        hooks[key] = overrides[key];
    });

    hooks.calls = calls;
    return hooks;
};

describe('runDiscordTest', function () {
    it('marks busy, runs the request, then reports success', function () {
        var hooks = hooksWith();
        runDiscordTest(hooks);

        hooks.calls.requested.should.eql(1);
        hooks.calls.success.should.eql(1);
        hooks.calls.error.should.eql(0);
        // Busy is raised before the request and cleared after it.
        hooks.calls.busy.should.eql([true, false]);
    });

    it('reports an error and no success when the request fails', function () {
        var hooks = hooksWith({
            request: function (cb) {
                cb(new Error('nope'));
            }
        });
        runDiscordTest(hooks);

        hooks.calls.error.should.eql(1);
        hooks.calls.success.should.eql(0);
        hooks.calls.busy.should.eql([true, false]);
    });

    it('does nothing when a test is already in flight', function () {
        var hooks = hooksWith({
            isBusy: function () {
                return true;
            }
        });
        runDiscordTest(hooks);

        hooks.calls.requested.should.eql(0);
        hooks.calls.busy.should.eql([]);
    });

    // The regression this guards: the busy state must be cleared before the (possibly throwing)
    // alert, so an alert that throws can never leave the button stuck disabled.
    it('clears busy before the success alert, even if that alert throws', function () {
        var hooks = hooksWith({
            onSuccess: function () {
                throw new Error('alert boom');
            }
        });

        (function () {
            runDiscordTest(hooks);
        }).should.throw(/alert boom/);

        hooks.calls.busy.should.eql([true, false]);   // cleared before the throw
    });

    it('clears busy before the error alert, even if that alert throws', function () {
        var hooks = hooksWith({
            request: function (cb) {
                cb(new Error('nope'));
            },
            onError: function () {
                throw new Error('alert boom');
            }
        });

        (function () {
            runDiscordTest(hooks);
        }).should.throw(/alert boom/);

        hooks.calls.busy.should.eql([true, false]);
    });
});
