---
part: crawl-enumerate
owns:
  - src/release/crawl/enumerate.mjs
  - src/release/crawl/enumerate.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/session.mjs
test: node --test src/release/crawl/enumerate.test.mjs
allow: []
---
# Part 16: which things on a page are worth clicking

A release check replays the same clicks on two versions of an app and compares what the page shows. Today a person writes those clicks. The crawl finds them itself, and this part is the pure
decision logic: given a list of descriptions of the interactive elements on a page, which ones are safe and useful to click, how to name them, and how to tell one page state from another.
It has no browser and no file or network access, so every test is offline. The browser part reads the page and passes the descriptions in (a later part).

An element description (`desc`) is a plain object:
`{ tag, role, name, href, type, disabled, visible, inForm, formMethod, download, path, nth, x, y, w, h }`
where `role` is the ARIA role or the one the tag implies (`link`, `button`, `tab`, `menuitem`, `checkbox`, `switch`, `radio`, `combobox`, `textbox`, `summary`...), `name` the accessible name as text,
`href` the absolute URL of a link or `''`, `type` the input type or `''`, `disabled` and `visible` booleans, `inForm` whether it sits inside a `<form>`, `formMethod` that form's method in lower case (`get` or `post`, `''` when none),
`download` true for a link with a `download` attribute, `path` a CSS path that identifies the element, `nth` the zero-based index among elements with the same role and name, and `x, y, w, h` the box in CSS pixels.

## `enumerate.mjs` must export

### `cleanName(text) -> string`
Collapse any run of whitespace (including newlines) to one space, trim, and cut to 60 characters (cut, never add dots). Non-strings give `''`.

### `isRisky(desc) -> string | null`
Returns the reason a click could change data or leave the app, or `null` when it is fine. Checked on the lower-cased `name` and on the `href` path:
- the name contains any of: `delete`, `remove`, `destroy`, `erase`, `wipe`, `purge`, `reset`, `clear all`, `empty trash`, `empty the trash`, `log out`, `logout`, `sign out`, `signout`, `unsubscribe`, `deactivate`, `close account`, `cancel subscription`, `mark all`, `pay `, `purchase`, `buy `, `checkout`, `place order`, `confirm order`, `send`, `submit`, `publish`, `post ` followed by anything, `save`, `import`, `upload`, `install`, `uninstall` (reason `name suggests it changes data: <word>`);
- the `href` path (the part after the host, lower case) contains `logout`, `signout`, `delete`, `remove`, `unsubscribe` or `checkout` (reason `link suggests it changes data`);
- `formMethod` is `post`, `put`, `patch` or `delete`, or `type` is `submit` or `reset` or `file` or `password`, when `inForm` (reason `submits a form`);
- `download` is true, or the `href` path ends in `.zip`, `.exe`, `.dmg`, `.pdf`, `.tar`, `.gz` (reason `a download`).
Words are matched as whole words or word starts (so `save` matches `Save draft` but not `Savage`; `send` matches `Send` but not `Sender`): use a word-boundary rule at the START of the word.

### `isInternal(desc, origin) -> boolean`
True when `href` is empty, or starts with `#`, or its origin equals `origin` (use `new URL`; a bad URL is not internal). `mailto:`, `tel:`, `javascript:` and `data:` links are never internal.

### `selectorFor(desc) -> string`
When `name` (after `cleanName`) is non-empty: `role=<role>[name="<name with backslash and double quote escaped by a backslash>"]`, followed by ` >> nth=<nth>` when `nth` is greater than 0. When there is no name: `css=<path>`. The role must contain only letters and dashes, otherwise use `css=<path>`.

### `candidates(descs, { origin, perPage = 12 } = {}) -> [{ action, label, role, name, key, href }]`
Keep descriptions that are `visible`, not `disabled`, not risky, and internal. Drop a description whose `key` (`<role>|<name>|<href>`, name cleaned) was already kept (first one wins). Drop roles other than: `link`, `button`, `tab`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `checkbox`, `switch`, `radio`, `summary`, `option`, `treeitem`.
Order by: role rank (`tab`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `summary`, `treeitem`, `button`, `link`, `checkbox`, `switch`, `radio`, `option`), then `y`, then `x`, then `key` (so the order is fully determined). Keep at most `perPage`.
Each result is `{ action: { type: 'click', selector: selectorFor(desc) }, label: '<role> "<name>"', role, name, key, href }` (for a role of `checkbox`, `switch` or `radio` the action type is still `click`).

### `stateKey(url, descs) -> string`
A short fingerprint of what a page state looks like to a user: the first 16 hex characters of the sha256 (use `node:crypto`) of the URL's pathname and search string (never the hash fragment and never the host), a newline, and the sorted, de-duplicated `role|name` of every `visible` description (cleaned names, empty names skipped), one per line. The same page with elements in another order gives the same key; a menu that opened and added items gives a different one. A bad URL is treated as the empty string.

## Tests (offline)

Build descriptions by hand. Cover: `cleanName`; `isRisky` for each group above and for look-alikes that must NOT match (`Savage`, `Sender`, `Remove` inside a longer word such as `Removed items` should still match `remove` at a word start: decide by the word-start rule and test it), links to `/logout`, a post form submit, a download, and a harmless button; `isInternal` for relative, hash, same origin, other origin, `mailto:`, bad URL; `selectorFor` with quotes and backslashes in the name, with `nth`, without a name, with a bad role; `candidates`: filtering of hidden, disabled, risky and external ones, de-duplication, role-rank ordering, determinism when the input order is shuffled, the `perPage` limit, and the shape of each result; `stateKey`: stable under reordering and duplicates, changes when an element appears, ignores the hash fragment, the host and hidden elements.
