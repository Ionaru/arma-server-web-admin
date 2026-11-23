require('should');
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

    describe('cross-origin protection (B14)', function () {
        it('B14: a state-changing request with a foreign Origin answers 403 before validation', async function () {
            const res = await request(app)
                .put('/api/op-mode')
                .set('Origin', 'http://evil.example')
                .send({enabled: true, days: [0], time: 'half seven', opServerId: 'whatever'});
            res.status.should.equal(403);
            res.headers['content-type'].should.match(/json/);
            res.body.should.eql({error: 'Cross-origin request refused'});
        });

        // Always sends the header: without it this would start an op mode run.
        it('B14: an op mode run with Sec-Fetch-Site cross-site answers 403', async function () {
            await request(app)
                .post('/api/op-mode/run')
                .set('Sec-Fetch-Site', 'cross-site')
                .expect(403);
        });

        it('B14: a read with a foreign Origin is still served', async function () {
            await request(app)
                .get('/api/servers')
                .set('Origin', 'http://evil.example')
                .expect('Content-Type', /json/)
                .expect(200);
        });
    });

    it('should serve servers', function (done) {
        requestPath('/api/servers', /json/, done);
    });

    it('should serve settings', function (done) {
        requestPath('/api/settings', /json/, done);
    });
});
