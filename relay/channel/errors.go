package channel

import "errors"

// ErrNotImplemented is returned by the generated adaptor stubs for a capability
// the channel does not implement. Callers must test it with errors.Is rather
// than matching the message text: the wording is not a contract, and a substring
// check also matches unrelated errors that merely mention the phrase.
var ErrNotImplemented = errors.New("not implemented")
