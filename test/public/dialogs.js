require('should');

var dialogs = require('../../public/js/app/dialogs.js');

// Replaces dialogs.swal with a fake whose fire() records its arguments and returns `result`.
var fakeSwal = function (result) {
    var fake = {
        calls: [],
        fire: function (options) {
            fake.calls.push(options);
            return result;
        }
    };

    return fake;
};

var confirmOptions = function (danger) {
    return {
        title: 'Are you sure?',
        text: 'The mission will be deleted from the server!',
        confirmText: 'Yes, delete it!',
        danger: danger
    };
};

var expectedConfirm = function (buttonClass) {
    return {
        icon: 'warning',
        title: 'Are you sure?',
        text: 'The mission will be deleted from the server!',
        showCancelButton: true,
        confirmButtonText: 'Yes, delete it!',
        cancelButtonText: 'Cancel',
        buttonsStyling: false,
        customClass: {confirmButton: buttonClass, cancelButton: 'btn btn-default'},
        reverseButtons: true
    };
};

var nextMacrotask = function () {
    return new Promise(function (resolve) {
        setTimeout(resolve, 0);
    });
};

describe('dialogs', function () {
    var original;

    beforeEach(function () {
        original = dialogs.swal;
    });

    afterEach(function () {
        dialogs.swal = original;
    });

    describe('B1 alert', function () {
        it('B1 fires one dialog with the icon, title, text and Bootstrap button, and returns its promise', function () {
            var returned = Promise.resolve({isConfirmed: true});
            var fake = dialogs.swal = fakeSwal(returned);

            var result = dialogs.alert('error', 'Error', 'boom');

            fake.calls.length.should.eql(1);
            fake.calls[0].should.eql({
                icon: 'error',
                title: 'Error',
                text: 'boom',
                buttonsStyling: false,
                customClass: {confirmButton: 'btn btn-primary'}
            });
            (result === returned).should.be.true();
        });
    });

    describe('B2 danger confirm', function () {
        it('B2 fires the danger dialog and calls cb once with no arguments after Confirm', async function () {
            var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: true, isDenied: false, isDismissed: false}));
            var cbArgs = [];

            var promise = dialogs.confirm(confirmOptions(true), function () {
                cbArgs.push(Array.prototype.slice.call(arguments));
            });

            fake.calls.length.should.eql(1);
            fake.calls[0].should.eql(expectedConfirm('btn btn-danger'));

            await promise;
            await nextMacrotask();

            cbArgs.should.eql([[]]);
        });
    });

    describe('B3 non-danger confirm', function () {
        it('B3 uses the warning button and calls cb once after Confirm', async function () {
            var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: true, isDenied: false, isDismissed: false}));
            var cbArgs = [];

            var promise = dialogs.confirm(confirmOptions(false), function () {
                cbArgs.push(Array.prototype.slice.call(arguments));
            });

            fake.calls.length.should.eql(1);
            fake.calls[0].should.eql(expectedConfirm('btn btn-warning'));

            await promise;
            await nextMacrotask();

            cbArgs.should.eql([[]]);
        });
    });

    describe('B4 dismissed', function () {
        ['cancel', 'esc', 'backdrop', 'close'].forEach(function (dismiss) {
            it('B4 never calls cb when dismissed by ' + dismiss, async function () {
                dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: false, isDismissed: true, dismiss: dismiss}));
                var called = 0;

                var promise = dialogs.confirm(confirmOptions(true), function () {
                    called++;
                });

                await promise;
                await nextMacrotask();

                called.should.eql(0);
            });
        });
    });

    describe('B5 text stays text', function () {
        it('B5 passes markup as text and sets no html option', function () {
            var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: true}));

            dialogs.alert('error', 'Error', '<b>x</b>');

            fake.calls.length.should.eql(1);
            fake.calls[0].text.should.eql('<b>x</b>');
            fake.calls[0].should.not.have.property('html');
        });
    });
});
