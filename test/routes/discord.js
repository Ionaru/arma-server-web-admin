require('should');
var express = require('express');
var request = require('supertest');

var discordRoute = require('../../routes/discord.js');

var FakeDiscord = function (behaviour) {
    this.behaviour = behaviour || {};
    this.sent = [];
};
FakeDiscord.prototype.isConfigured = function () {
    return this.behaviour.configured !== false;
};
FakeDiscord.prototype.send = function (content, cb) {
    this.sent.push(content);
    cb(this.behaviour.sendError || null);
};

var appWith = function (discord) {
    var app = express();
    app.use('/api/discord', discordRoute(discord));
    return app;
};

describe('routes/discord', function () {
    it('POST /test returns 400 when Discord is not configured', function (done) {
        request(appWith(new FakeDiscord({configured: false})))
            .post('/api/discord/test')
            .expect('Content-Type', /json/)
            .expect(400, {error: 'Discord is not configured'}, done);
    });

    it('POST /test posts a message and returns 200 on success', function (done) {
        var discord = new FakeDiscord();

        request(appWith(discord))
            .post('/api/discord/test')
            .expect(200, {ok: true})
            .end(function (err) {
                if (err) {
                    return done(err);
                }

                discord.sent.length.should.eql(1);
                done();
            });
    });

    it('POST /test returns 502 with the message when Discord rejects it', function (done) {
        var discord = new FakeDiscord({sendError: new Error('Discord responded 403: Missing Permissions')});

        request(appWith(discord))
            .post('/api/discord/test')
            .expect('Content-Type', /json/)
            .expect(502, {error: 'Discord responded 403: Missing Permissions'}, done);
    });
});
