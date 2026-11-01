---
part: login
owns:
  - src/release/login.mjs
  - src/release/login.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/session.mjs
test: node --test src/release/login.test.mjs
allow: []
---
# Part 29: a login step a person approves

Apps behind a login show the crawler and the recorder one page: the login form. An app profile may now carry a `login` block that says where the form is, which fields to fill, what to click, and where the password comes from. This part turns that block into the recorder's own actions (`src/session.mjs` `act`: `goto`, `fill`, `click`, `wait`), validates it, inserts it where the pipeline resets state, and makes sure the password never reaches a log or the evidence record. Pure: no browser, no file, no process.

## The `login` block of a profile

```json
{
  "path": "/login",
  "user": { "selector": "input[name=username]", "value": "admin" },
  "password": { "selector": "input[name=password]", "env": "BEHIQUE_LOGIN_PASSWORD" },
  "submit": { "selector": "button[type=submit]" },
  "expect": { "selector": "nav .logout" },
  "public": false,
  "note": "the demo admin account"
}
```
`password` is either `{ selector, env }` (the password is read from that environment variable at run time) or `{ selector, value }` (written into the profile), which is allowed only when `public` is `true`: a documented default account of a demo app, such as umami's `admin` / `umami`, that a person chose to write down. `expect` is optional and names a selector that should exist after the login (the pipeline may check it; this part only validates it). `note` is optional text.

## `login.mjs` must export

### `validateLogin(login) -> string[]`
Problems, each a sentence a person can act on; an empty array means valid. Rules: `login` must be a plain object with no keys other than `path`, `user`, `password`, `submit`, `expect`, `public`, `note`; `path` a string starting with `/`, at most 200 characters, no whitespace; `user`, `password` and `submit` objects whose `selector` is a non-empty string of at most 200 characters with no newline; `user.value` a string of at most 200 characters; `password` has exactly one of `env` (matching `/^[A-Z][A-Z0-9_]{0,63}$/`) or `value` (a string of at most 200 characters); `password.value` without `public === true` is the problem `the password belongs in the environment: set password.env, or set public to true for a documented default account`; `expect`, when present, an object with a `selector` under the same rule; `public`, when present, a boolean; `note`, when present, a string of at most 500 characters.

### `loginActions(login, env = {}) -> actions`
The recorder's actions, in order: `{ type: 'goto', path }`, `{ type: 'fill', selector: user.selector, text: user.value }`, `{ type: 'fill', selector: password.selector, text: <password>, secret: true }`, `{ type: 'click', selector: submit.selector }`, `{ type: 'wait', ms: 800 }`. The password is `login.password.value`, or `env[login.password.env]`; when that variable is missing or empty, throw `the login password <NAME> is not set in the environment`. Throws on an invalid block (the first problem of `validateLogin`).

### `redactActions(actions) -> actions`
A copy of the list where every action with `secret: true` has its `text` replaced by `[redacted]` (the `secret` flag stays). Other actions are unchanged. Used before steps are written to the evidence record, a log or a page. Non-arrays give `[]`.

### `withLogin(steps, login, env = {}) -> steps`
The recorder clears cookies and storage at every `{ type: 'goto', path: '/' }` (the start of a flow), so a login must be repeated there. Returns a new list: the login actions, then the steps, with the login actions inserted again after every `goto /` step. The input list is never mutated. With `login` null or undefined, returns a copy of `steps`.

### `stripLogin(steps) -> steps`
The inverse for display: removes every action that came from a login (mark them with `fromLogin: true` in `loginActions` so this is exact), so a person sees the crawled steps only.

### `describeLogin(login) -> string`
One line for the approval list: `login: <path> as "<user.value>" (password from <ENV>)` or `(password written in the profile, a public default account)`.

## Tests (offline)

Cover: `validateLogin` accepts the example and refuses each rule (unknown key, bad path, missing selector, both env and value, value without public, bad env name, long note); `loginActions` with env and with value, the secret flag, the error when the variable is missing, the error on an invalid block; `redactActions` hides only the secret text and leaves other actions untouched, and does not mutate its input; `withLogin` prepends, repeats after each `goto /` and nowhere else, leaves the input untouched, and returns a copy when there is no login; `stripLogin` removes exactly the inserted actions so `stripLogin(withLogin(steps, login))` deep-equals `steps`; `describeLogin` for both password kinds. No test writes a real password anywhere but a test string.
