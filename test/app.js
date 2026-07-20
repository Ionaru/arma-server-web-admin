const request = require('supertest');

const app = require('../app');

function requestPath(path, contentType, done) {
    request(app)
        .get(path)
        .expect('Content-Type', contentType)
        .expect(200)
        .end(done);
}

describe('App', function () {
    it('should serve main page', function (done) {
        requestPath('/', /html/, done);
    });

    it('should serve logs', function (done) {
        requestPath('/api/logs', /json/, done);
    });

    it('should serve missions', function (done) {
        requestPath('/api/missions', /json/, done);
    });

    it('should serve mods', function (done) {
        requestPath('/api/mods', /json/, done);
    });

    it('should serve op mode', function (done) {
        requestPath('/api/op-mode', /json/, done);
    });

    // Rejected regardless of what op-mode.json happens to hold, unlike the run endpoint, whose
    // outcome depends on the ambient config. That is covered in isolation in test/lib/op-mode.js.
    it('should reject an invalid op mode schedule', function (done) {
        request(app)
            .put('/api/op-mode')
            .send({enabled: true, days: [0], time: 'half seven', opServerId: 'whatever'})
            .expect('Content-Type', /json/)
            .expect(400)
            .end(done);
    });

    it('should serve servers', function (done) {
        requestPath('/api/servers', /json/, done);
    });

    it('should serve settings', function (done) {
        requestPath('/api/settings', /json/, done);
    });
});
