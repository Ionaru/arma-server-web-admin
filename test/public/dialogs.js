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
        customClass: {confirmButton: buttonClass, cancelButton: 'btn btn-secondary'},
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

    // B11: while a Bootstrap modal is open its focus trap takes the keyboard back from anything outside
    // it, so a dialog opened then is rendered inside the modal (sweetalert2 `target`). The lookup runs
    // when the dialog is opened, and the key is absent when there is no modal (and no document, as here).
    describe('B11 target inside an open modal', function () {
        var hadDocument;
        var originalDocument;
        var modal;
        var selectors;

        beforeEach(function () {
            hadDocument = 'document' in global;
            originalDocument = global.document;
            modal = {className: 'modal show'};
            selectors = [];
            global.document = {
                querySelector: function (selector) {
                    selectors.push(selector);

                    return selector === '.modal.show' ? modal : null;
                }
            };
        });

        afterEach(function () {
            if (hadDocument) {
                global.document = originalDocument;
            } else {
                delete global.document;
            }
        });

        it('B11 alert adds the open modal as target', function () {
            var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: true}));

            dialogs.alert('error', 'Error', 'boom');

            fake.calls.length.should.eql(1);
            (fake.calls[0].target === modal).should.be.true();
            fake.calls[0].should.eql({
                icon: 'error',
                title: 'Error',
                text: 'boom',
                buttonsStyling: false,
                customClass: {confirmButton: 'btn btn-primary'},
                target: modal
            });
            selectors.should.containEql('.modal.show');
        });

        [true, false].forEach(function (danger) {
            it('B11 confirm adds the open modal as target (danger ' + danger + ')', function () {
                var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: false, isDismissed: true}));
                var expected = expectedConfirm(danger ? 'btn btn-danger' : 'btn btn-warning');

                expected.target = modal;

                dialogs.confirm(confirmOptions(danger), function () {});

                fake.calls.length.should.eql(1);
                (fake.calls[0].target === modal).should.be.true();
                fake.calls[0].should.eql(expected);
            });
        });

        it('B11 adds no target key when no modal is open', function () {
            var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: true}));

            modal = null;

            dialogs.alert('error', 'Error', 'boom');
            dialogs.confirm(confirmOptions(true), function () {});

            fake.calls.length.should.eql(2);
            fake.calls[0].should.not.have.property('target');
            fake.calls[1].should.not.have.property('target');
            fake.calls[1].should.eql(expectedConfirm('btn btn-danger'));
        });

        it('B11 looks for the modal each time a dialog is opened, before it is fired', function () {
            var first = modal;
            var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: true}));

            dialogs.alert('error', 'Error', 'one');

            modal = null;
            dialogs.alert('error', 'Error', 'two');

            modal = {className: 'modal show'};
            dialogs.alert('error', 'Error', 'three');

            fake.calls.length.should.eql(3);
            (fake.calls[0].target === first).should.be.true();
            fake.calls[1].should.not.have.property('target');
            (fake.calls[2].target === modal).should.be.true();
        });
    });

    describe('B11 no document', function () {
        it('B11 adds no target key when document is undefined', function () {
            var hadDocument = 'document' in global;
            var originalDocument = global.document;
            var fake = dialogs.swal = fakeSwal(Promise.resolve({isConfirmed: true}));

            delete global.document;

            try {
                dialogs.alert('error', 'Error', 'boom');
                dialogs.confirm(confirmOptions(false), function () {});
            } finally {
                if (hadDocument) {
                    global.document = originalDocument;
                }
            }

            fake.calls.length.should.eql(2);
            fake.calls[0].should.not.have.property('target');
            fake.calls[1].should.not.have.property('target');
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
