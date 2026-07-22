require('should');

var Discord = require('../../lib/discord.js');

// A fake https.request: records the options + written body, and drives a fake response through
// the callback so no socket is ever opened.
var fakeRequest = function (behaviour) {
    behaviour = behaviour || {};
    var calls = [];

    var fn = function (options, responseCb) {
        var call = {options: options, body: ''};
        calls.push(call);

        var res = {
            statusCode: behaviour.statusCode || 204,
            handlers: {},
            on: function (event, handler) {
                res.handlers[event] = handler;
                return res;
            }
        };

        var req = {
            on: function (event, handler) {
                if (event === 'error' && behaviour.transportError) {
                    // Fire asynchronously, like a real socket error.
                    setImmediate(function () {
                        handler(behaviour.transportError);
                    });
                }
                return req;
            },
            write: function (data) {
                call.body += data;
            },
            end: function () {
                if (behaviour.transportError) {
                    return;
                }
                // Deliver the response on next tick, mimicking https.
                setImmediate(function () {
                    responseCb(res);
                    if (res.handlers.data && behaviour.responseBody) {
                        res.handlers.data(behaviour.responseBody);
                    }
                    if (res.handlers.end) {
                        res.handlers.end();
                    }
                });
            }
        };

        return req;
    };

    fn.calls = calls;
    return fn;
};

describe('Discord', function () {
    describe('isConfigured()', function () {
        it('is false without token or channelId', function () {
            Discord.isConfigured(undefined).should.be.false();
            Discord.isConfigured({}).should.be.false();
            Discord.isConfigured({token: 't'}).should.be.false();
            Discord.isConfigured({channelId: 'c'}).should.be.false();
            Discord.isConfigured({token: '', channelId: ''}).should.be.false();
        });

        it('is true with both token and channelId', function () {
            Discord.isConfigured({token: 't', channelId: 'c'}).should.be.true();
        });

        it('is exposed as an instance method too', function () {
            new Discord({token: 't', channelId: 'c'}).isConfigured().should.be.true();
            new Discord({}).isConfigured().should.be.false();
        });
    });

    describe('send()', function () {
        it('posts to the v10 channel messages endpoint with the required headers and body', function (done) {
            var discord = new Discord({token: 'abc', channelId: '123'});
            discord.request = fakeRequest({statusCode: 204});

            discord.send('hello world', function (err) {
                (err === null || err === undefined).should.be.true();

                discord.request.calls.length.should.eql(1);
                var call = discord.request.calls[0];
                call.options.method.should.eql('POST');
                call.options.hostname.should.eql('discord.com');
                call.options.path.should.eql('/api/v10/channels/123/messages');
                call.options.headers.Authorization.should.eql('Bot abc');
                call.options.headers['Content-Type'].should.eql('application/json');
                call.options.headers['User-Agent'].should.match(/^DiscordBot \(.+, .+\)$/);
                JSON.parse(call.body).content.should.eql('hello world');
                done();
            });
        });

        it('calls back with an error and posts nothing when not configured', function (done) {
            var discord = new Discord({});
            discord.request = fakeRequest();

            discord.send('hello', function (err) {
                err.should.be.an.Error();
                discord.request.calls.length.should.eql(0);
                done();
            });
        });

        it('calls back with an error on a non-2xx status', function (done) {
            var discord = new Discord({token: 'abc', channelId: '123'});
            discord.request = fakeRequest({statusCode: 403, responseBody: '{"message":"Missing Permissions","code":50013}'});

            discord.send('hello', function (err) {
                err.should.be.an.Error();
                err.message.should.match(/403/);
                err.message.should.match(/50013/);
                done();
            });
        });

        it('calls back with an error on a transport failure', function (done) {
            var discord = new Discord({token: 'abc', channelId: '123'});
            discord.request = fakeRequest({transportError: new Error('ECONNREFUSED')});

            discord.send('hello', function (err) {
                err.should.be.an.Error();
                err.message.should.match(/ECONNREFUSED/);
                done();
            });
        });
    });
});
