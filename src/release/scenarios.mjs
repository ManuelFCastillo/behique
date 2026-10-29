// Known cases the release checker can be pointed at: a feed fixture (the adapter), the clicks to replay, and an honest
// description of what is known upstream. The description is stored with each report, because the check proves that
// behaviour DIFFERS between two versions; it cannot say whether the difference is a bug. A person decides that.
// The apps a run can target. A scenario belongs to exactly one app.
export const APPS = {
  freshrss: { label: 'FreshRSS', adapter: 'freshrss', defaults: { good: '1.29.1', cand: '1.30.0' } },
}

export const SCENARIOS = {
  share: {
    label: 'Share menu link',
    app: 'freshrss',
    adapter: 'freshrss',
    steps: 'bench/fixtures/freshrss/steps.json',
    upstream: { issue: 9302, url: 'https://github.com/FreshRSS/FreshRSS/issues/9302' },
    about: 'In 1.30.0 the Share menu’s Clipboard item copies a URL-encoded link instead of a normal one. Reported upstream as #9302, “Regression with sharing links”, closed as completed.',
  },
  scroll: {
    label: 'Scroll position when opening an article',
    app: 'freshrss',
    adapter: 'freshrss-scroll',
    steps: 'bench/fixtures/freshrss-scroll/steps.json',
    upstream: { issue: 9285, url: 'https://github.com/FreshRSS/FreshRSS/issues/9285' },
    about: 'Reported upstream as #9285: with “Stick the article to the top when opened” switched off, scrolling behaves differently in 1.30.0. The maintainers could not reproduce it as described, the reporter closed it, and no fix was made. The behaviour was changed on purpose in #8870. This check shows that the behaviour really does differ between the two versions in one concrete case. Whether that is a bug is for a person to decide.',
  },
}
