#!/usr/bin/env python3
"""Writes sections.html for the Airlock panel redesign prototype. Every name and number is invented."""
import html
from pathlib import Path

E = html.escape
OUT = Path(__file__).with_name('sections.html')

LOGO = ('<svg class="ap-logo" viewBox="0 0 128 128" aria-hidden="true"><rect x="4" y="4" width="120" height="120" rx="28" fill="#1f5fd0"/>'
        '<circle cx="64" cy="64" r="35" fill="none" stroke="#fff" stroke-width="13" stroke-linecap="round" stroke-dasharray="74.5 35.46" transform="rotate(-61 64 64)"/>'
        '<circle cx="64" cy="64" r="12" fill="#fff"/></svg>')


def ic(name, cls='size-4'):
    return f'<i data-lucide="{name}" class="{cls}"></i>'


CHROME = ('<!--chrome--><div class="ap-chrome"><span>Side panel</span><b style="color:var(--fg)">Airlock</b>'
          f'<span style="margin-left:auto">{ic("x", "size-3.5")}</span></div><!--/chrome-->')
HEAD = ('<!--chrome--><div class="ap-head">' + LOGO + '<span class="ap-name">Airlock</span>'
        '<span class="ap-state"><i></i>Connected</span>'
        f'<span class="btn small" data-to="settings" data-id="settings-button">{ic("settings", "size-3.5")}Settings</span></div><!--/chrome-->')


def back_head(label, right=''):
    return (f'<div class="ap-head"><span class="ap-back" data-back>{ic("chevron-left")}{E(label)}</span>{right}</div>')


SEV = {'block': 'Block', 'fix': 'Fix', 'ask': 'Ask', 'note': 'Note'}
SCREEN_TITLE = '<span class="ap-count" style="font-weight:700;color:var(--fg);font-size:14px">{}</span>'

PR = {'repo': 'acme-tools/click-to-call', 'n': 12, 'title': 'Add a call button to phone fields', 'head': 'a1b2c3d', 'login': 'dana-reviews'}

F = [
    dict(id='f1', sev='fix', short='Tests pass without testing the safety rules',
         gist='The test file only checks that certain lines exist in the source. The wrong-customer protections could break and the tests would still pass.',
         path='tests/safety.test.js', line=14, inline=True,
         todo='Load the content script in a test page with two customer cards and check the button is hidden under the second card. Keep the text checks only as a backup.',
         happens='`npm test` reads content.js as text and looks for three strings. It never runs the script against a page, so it cannot tell whether the button is hidden under a second customer card, when contacts are collapsed, or when the field is off screen.',
         why='The CHANGELOG presents this release as the fix for calling the wrong customer. A passing test run is the only evidence a reviewer has, and here it proves nothing about what the button does.',
         code="const src = fs.readFileSync('content.js', 'utf8');\nassert(src.includes('isSecondCard('));\nassert(src.includes('contactsCollapsed('));",
         involves=[('content.js:88', 'the rule the test claims to cover'), ('README.md:102', 'says the rules are covered by tests')],
         checked='Challenged. The reviewer looked for another test that loads the script against a page and found none.',
         wrong='Another test, outside this pull request, runs the script against a real page.',
         source='Extensions pack, Quality lens, rule Q4'),
    dict(id='f2', sev='ask', short='No proof the checks work on a real page',
         gist='The safety checks were tried only on a hand-built test page. The README says results go in the pull request description, which is empty.',
         path='README.md', line=88, inline=True,
         todo='Run the README\'s quick release list on a real customer page and paste the results, and anything not tried, into the description.',
         happens='The protections are: hide the button under a second customer card, hide it when Additional Contacts is collapsed, and hide it when the field is off screen. So far they have only been tried on a page built by hand for the test.',
         why='A real customer page has markup the test page does not. The last review asked for proof from a real tab, and none is recorded anywhere a reviewer can see.',
         code='## Quick release verification\n1. Open a customer card and press the call button on Phone 1.\n2. Open a second card: no button under it.',
         involves=[('CHANGELOG.md:6', 'calls this release the fix from the last review')],
         checked='Not challenged: questions are shown as asked.',
         wrong='The builder already ran the list on a real page and recorded it where the reviewer can see it.',
         source='Extensions pack, Data lens'),
    dict(id='f3', sev='ask', short='A second office may call from the wrong number',
         gist='The button hands the phone app a bare number. Nothing chooses which office\'s caller ID is used.',
         path='content.js', line=142, inline=False,
         why_summary='Line 142 of content.js is not part of this pull request\'s changes, so GitHub cannot put a comment there.',
         todo='Say in the description how the phone app picks the caller ID for a second office, or pass the office with the number.',
         happens='The link is `tel:+1…` with no office or line. Which number the customer sees depends on how the phone app is set up on each computer.',
         why='When a second office gets this extension, its staff could call customers from the first office\'s number, and a customer who calls back reaches the wrong office.',
         code="link.href = 'tel:+1' + digits;",
         involves=[],
         checked='Not challenged: questions are shown as asked.',
         wrong='The phone app always uses the signed-in person\'s own office line.',
         source='Extensions pack, Office lens'),
    dict(id='f4', sev='ask', short='The button also shows in read-only fields',
         gist='Staff who can only view a customer still get the call button. Is that intended?',
         path='content.js', line=61, inline=True,
         todo='If it is intended, say so in the README. If not, skip fields that are disabled or read-only.',
         happens='The field check looks at the type, name, label and placeholder. It does not look at `disabled` or `readonly`, so the button appears in view mode too.',
         why='Who may call a customer from their record is a decision for operations, and the code makes it without saying so.',
         code="if (looksLikePhone(field)) addButton(field);",
         involves=[('README.md:31', 'lists where the button appears; view mode is not mentioned')],
         checked='Not challenged: questions are shown as asked.',
         wrong='Operations already decided view-only staff should be able to call.',
         source='Extensions pack, Office lens'),
    dict(id='f5', sev='note', short='Numbers with an extension lose it',
         gist='"602-555-0142 ext 12" becomes a call to the main number. The extension is dropped without a word.',
         path='phone.js', line=20, inline=True,
         todo='Keep the extension in the link, or show it beside the button so the caller can enter it.',
         happens='The pattern accepts an optional extension and then builds the link from the first ten digits only.',
         why='The caller reaches a front desk instead of the person on the record, and nothing on screen says why.',
         code="const m = PHONE.exec(text);\nreturn m ? m[1] + m[2] + m[3] : null;",
         involves=[],
         checked='Not challenged: notes are shown as found.',
         wrong='The phone app asks for the extension by itself.',
         source='Generic pack, Correctness lens'),
    dict(id='f6', sev='note', short='Manifest and CHANGELOG disagree on the version',
         gist='manifest.json says 0.3.0 and the CHANGELOG\'s newest entry is 0.3.1.',
         path='manifest.json', line=4, inline=True,
         todo='Set both to the version this pull request ships.',
         happens='The version was raised in the CHANGELOG and not in the manifest.',
         why='The installed extension would report an older version than the notes describe, so nobody can tell which build a person has.',
         code='"version": "0.3.0",', involves=[('CHANGELOG.md:3', 'the newest entry')],
         checked='A code check found it; no model was involved.', wrong='The release step sets the manifest version.',
         source='Extensions pack, version check'),
    dict(id='f7', sev='note', short='An unused helper is left in content.js',
         gist='`formatForDisplay` is defined and never called.',
         path='content.js', line=210, inline=True,
         todo='Remove it, or use it where numbers are shown.',
         happens='The function was added with an earlier version of the button and nothing calls it now.',
         why='Dead code in a small extension gets copied into the next one.',
         code='function formatForDisplay(digits) {', involves=[],
         checked='Not challenged: notes are shown as found.', wrong='Another file in the extension calls it.',
         source='Generic pack, Correctness lens'),
    dict(id='f8', sev='fix', short='The new test page ships inside the extension',
         gist='tests/page.html is listed in the manifest, so every employee\'s browser can open it.',
         path='manifest.json', line=19, inline=True,
         todo='Take tests/page.html out of web_accessible_resources.',
         happens='The push that added a real test page also listed it as a resource any page can load.',
         why='A test page with sample customers and the call button becomes part of what is installed on every computer.',
         code='"resources": ["icons/*", "tests/page.html"]', involves=[('tests/page.html:1', 'the page')],
         checked='Challenged. The manifest loads it, so it is read as part of the extension.', wrong='The file is removed before release by a build step (there is none).',
         source='Extensions pack, Security lens'),
]
BY = {f['id']: f for f in F}
ORDER = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']


def where(f):
    return f"{f['path']}:{f['line']}"


def row(f, tag=None, sel=None):
    check = ''
    if sel is not None:
        check = f'<span class="ap-check{" on" if sel else ""}" data-toggled="select" hidden>{ic("check", "size-3") if sel else ""}</span>'
    extra = f' <span class="ap-tag sev-{tag[1]}">{tag[0]}</span>' if tag else ''
    return (f'<div class="ap-row" data-to="{f["id"]}" data-id="row-{f["id"]}">{check}<span class="ap-sev sev-{f["sev"]}">{SEV[f["sev"]]}</span>'
            f'<div class="ap-row-main"><span class="ap-row-title">{E(f["short"])}</span><span class="ap-row-sub">{E(where(f))}{extra}</span></div>'
            f'{ic("chevron-right", "size-4 ap-go")}</div>')


def fold(key, title, n, body):
    return (f'<div class="ap-fold" data-toggle="{key}" data-id="fold-{key}">{ic("chevron-right", "size-4")}<span>{E(title)}</span><span class="n">{E(n)}</span></div>'
            f'<div class="ap-folded" data-toggled="{key}" hidden>{body}</div>')


def points(items, steps=False):
    return f'<div class="ap-points{" ap-steps" if steps else ""}">' + ''.join(f'<div><span>{E(i)}</span></div>' for i in items) + '</div>'


def verdict(word, sev, headline, chips, meta, extra=''):
    c = ''.join(f'<span class="ap-chip sev-{s}">{E(t)}</span>' for t, s in chips)
    return (f'<div class="ap-verdict" data-id="verdict"><div class="ap-vword sev-{sev}">{E(word)}</div><p class="ap-headline">{E(headline)}</p>'
            f'<div class="ap-chips">{c}</div>{extra}<p class="muted">{E(meta)}</p></div>')


def tabs(group, items):
    out = '<div class="ap-tabs">'
    for i, (value, label) in enumerate(items):
        out += (f'<span class="ap-tab{" on" if i == 0 else ""}" data-tabs="{group}" data-tab="{value}" data-label="{E(label)}" data-on="on" data-off=""'
                f'{" data-default" if i == 0 else ""}>{E(label)}</span>')
    return out + '</div>'


def findings_panel(prefix):
    top = ''.join(row(BY[i], sel=(i in ('f1', 'f2'))) for i in ORDER[:5])
    also = ''.join(row(BY[i]) for i in ORDER[5:])
    return f'<div class="ap-list">{top}</div>' + fold(f'{prefix}also', 'Also found', '2 notes', f'<div class="ap-list">{also}</div>')


IN_SHORT = 'Adds a call button inside phone fields. Pressing it opens the desk phone app with that number.'
WHAT = ['Runs only on the customer system\'s pages and asks for no new permissions.',
        'Shows a small call button in fields that look like phone fields.',
        'Hides the button where it could call the wrong customer: under a second card, in collapsed contacts, in fields off screen.']
QUESTIONS = ['Will a second office\'s staff call from their own office\'s number?', 'Should view-only staff get the call button?']
WHOSE = ['Operations decides which roles get the call button.']
CHECKS = ['Load the extension as a scheduler and call Phone 1 from a real customer card.', 'Open a second customer card: no button under it.',
          'Collapse Additional Contacts: the buttons there disappear.']
PR_TEXT = 'Self-review: ran the quick release list on the test page only. Not tried on a real customer page yet.'


def change_panel(prefix):
    return (f'<div class="ap-group"><span class="label">In short</span><p class="ap-short">{E(IN_SHORT)}</p></div>'
            + fold(f'{prefix}what', 'What it does', '3 points', points(WHAT))
            + '<span class="label" style="margin-top:6px">Before you merge</span>'
            + fold(f'{prefix}questions', 'Questions for the author', '2', points(QUESTIONS))
            + fold(f'{prefix}whose', 'Whose call', '1', points(WHOSE))
            + fold(f'{prefix}checks', 'Check after merge', '3 steps', points(CHECKS, steps=True))
            + fold(f'{prefix}text', 'Text for your pull request', 'copy',
                   f'<div class="quote">{E(PR_TEXT)}</div><span class="btn small" style="align-self:flex-start" data-toast="Copied">{ic("copy", "size-3.5")}Copy</span>')
            + fold(f'{prefix}files', 'Files', '14',
                   '<p>6 read closely, 5 skimmed, 3 trusted as tests.</p>' + points(['Call button: content.js, phone.js, styles.css', 'Setup: manifest.json, README.md, CHANGELOG.md', 'Tests: tests/safety.test.js and 2 more'])))


def more_panel(prefix):
    dismissed = ('<div class="ap-row" style="cursor:default"><span class="ap-sev sev-note">Note</span><div class="ap-row-main"><span class="ap-row-title">Button colour differs from the style guide</span>'
                 '<span class="ap-row-sub">Hidden on this pull request only</span></div><span class="btn small" data-toast="The finding would return to the list">Restore</span></div>')
    return (f'<p class="muted">Reviewed at {PR["head"]} · Standard depth · 5 min 25 s · Packs: Extensions, Generic</p>'
            f'<span class="btn wide" data-toast="A new review of this pull request would start">{ic("rotate-cw", "size-3.5")}Review again</span>'
            + fold(f'{prefix}limits', 'Not shown to the reviewer', '1', '<p>82 of 673 changed lines in one large file were cut before the challenge step.</p>')
            + fold(f'{prefix}notes', 'Notes from the review', '2', points(['A question was merged into the finding about proof on a real page.', 'Two findings about the test file were merged into one.']))
            + fold(f'{prefix}dismissed', 'Dismissed', '1', dismissed)
            + fold(f'{prefix}timing', 'Timing', '9 steps', '<p class="muted">Reading 12 s · Grouping 31 s · Finding 2 min 40 s · Challenging 1 min 12 s · Ranking 18 s · the rest 32 s</p>'))


HOME_VERDICT = verdict('Approve after fixes', 'fix', 'One thing to fix before merging: the tests do not test the safety rules.',
                       [('1 to fix', 'fix'), ('3 questions', 'ask'), ('3 notes', 'note')], f'{PR["head"]} · Standard · 5 notes shown in the diff')

HOME_BAR = (
    '<div class="ap-bar" data-toggled-off="select">'
    f'<span class="btn primary" style="flex:1" data-toast="Copied one prompt covering the 1 fix. Paste it to your coding agent.">{ic("copy", "size-3.5")}Copy fix prompt for the 1 fix</span>'
    '<span class="btn" data-toggle="select">Select</span></div>'
    '<div class="ap-bar" data-toggled="select" hidden>'
    '<span class="btn" style="flex:1" data-toast="Copied one prompt covering the 2 selected findings">Copy fix prompt (2)</span>'
    '<span class="btn primary" style="flex:1" data-to="post-many">Comment on GitHub (2)</span>'
    '<span class="btn" data-toggle="select">Done</span></div>')


def home():
    a = (tabs('tab', [('findings', 'Findings · 7'), ('change', 'The change'), ('more', 'More')])
         + f'<div data-panel="tab:findings" class="ap-group">{findings_panel("a-")}</div>'
         + f'<div data-panel="tab:change" class="ap-group" hidden>{change_panel("a-")}</div>'
         + f'<div data-panel="tab:more" class="ap-group" hidden>{more_panel("a-")}</div>')
    b = ('<span class="label">Findings · 5</span>' + f'<div class="ap-group">{findings_panel("b-")}</div>'
         + fold('b-change', 'The change', 'summary', change_panel('b2-'))
         + fold('b-more', 'More', 'review again, notes, dismissed', more_panel('b2-')))
    return (f'<div class="screen ap" data-id="home" data-device="phone" data-name="Review" data-route="Side panel, beside the pull request" data-start data-pack>{CHROME}{HEAD}'
            f'<div class="flex-1 min-h-0 overflow-y-auto ap-body" data-scroll>{HOME_VERDICT}'
            f'<div data-panel="c-split:A" class="ap-group" style="gap:12px">{a}</div><div data-panel="c-split:B" class="ap-group" style="gap:6px" hidden>{b}</div></div>'
            f'{HOME_BAR}</div>')


def home_push():
    chips = [('1 to fix', 'fix'), ('2 questions', 'ask')]
    since = ('<div class="ap-chips"><span class="ap-chip sev-ok">2 fixed</span><span class="ap-chip sev-note">2 still open</span><span class="ap-chip sev-fix">1 new</span></div>')
    v = verdict('Approve after fixes', 'fix', 'The push fixed the tests, and added one new thing to fix.', chips, 'f4e5d6c · reviewed the push since a1b2c3d · Standard',
                extra=f'<span class="label">Since the last review</span>{since}')
    rows = row(BY['f8'], tag=('New', 'fix')) + row(BY['f3'], tag=('Still open', 'note')) + row(BY['f4'], tag=('Still open', 'note'))
    fixed = ''.join(
        f'<div class="ap-row" data-to="{i}"><span class="ap-sev sev-ok">Fixed</span><div class="ap-row-main"><span class="ap-row-title">{E(BY[i]["short"])}</span>'
        f'<span class="ap-row-sub">{E(how)}</span></div>{ic("chevron-right", "size-4 ap-go")}</div>'
        for i, how in (('f1', 'confirmed: the test now loads a page'), ('f2', 'confirmed: results are in the description')))
    body = f'<div class="ap-list">{rows}</div>' + fold('p-fixed', 'Fixed since the last review', '2', f'<div class="ap-list">{fixed}</div>')
    bar = (f'<div class="ap-bar"><span class="btn primary" style="flex:1" data-toast="Copied one prompt covering the 1 fix">{ic("copy", "size-3.5")}Copy fix prompt for the 1 fix</span>'
           '<span class="btn" data-toast="Checkboxes would appear on the rows">Select</span></div>')
    return (f'<div class="screen ap" data-id="home2" data-device="phone" data-name="Review after a push" data-route="Side panel, after new commits" data-pack>{CHROME}{HEAD}'
            f'<div class="flex-1 min-h-0 overflow-y-auto ap-body" data-scroll>{v}<span class="label">Open findings · 3</span>{body}'
            f'<p class="muted">The notes on GitHub are hidden until you reload the page, because it was opened before this commit.</p>'
            f'<span class="btn small" style="align-self:flex-start" data-toast="The GitHub tab would reload and the notes would appear">Reload the GitHub tab</span></div>{bar}</div>')


def detail(f, idx, total):
    prev_id = ORDER[idx - 1] if idx > 0 else None
    next_id = ORDER[idx + 1] if idx + 1 < total else None
    nav = (f'<span class="ap-count">{idx + 1} of {total}</span>'
           + (f'<span class="ap-icon" data-to="{prev_id}" data-replace title="Previous finding">{ic("chevron-up")}</span>' if prev_id else f'<span class="ap-icon" style="opacity:.3">{ic("chevron-up")}</span>')
           + (f'<span class="ap-icon" data-to="{next_id}" data-replace title="Next finding">{ic("chevron-down")}</span>' if next_id else f'<span class="ap-icon" style="opacity:.3">{ic("chevron-down")}</span>'))
    k = f['id'] + '-'
    folds = fold(k + 'happens', 'What happens', '', f'<p>{E(f["happens"])}</p>') + fold(k + 'why', 'Why it matters', '', f'<p>{E(f["why"])}</p>')
    folds += fold(k + 'code', 'The code', where(f), f'<div class="quote">{E(f["code"])}</div>')
    if f['involves']:
        inv = ''.join(f'<div class="ap-where"><span class="path">{E(p)}</span><span class="muted" style="flex:2">{E(r)}</span></div>' for p, r in f['involves'])
        folds += fold(k + 'involves', 'Also involves', str(len(f['involves'])), inv)
    folds += fold(k + 'proof', 'How sure is this', '', f'<span class="label">Checked</span><p>{E(f["checked"])}</p><span class="label">It would be wrong if</span><p>{E(f["wrong"])}</p>'
                  f'<span class="label">From</span><p>{E(f["source"])}</p>')
    body = (f'<div class="ap-group" style="gap:8px"><span class="ap-tag sev-{f["sev"]}" style="align-self:flex-start">{SEV[f["sev"]]}</span>'
            f'<div class="ap-title">{E(f["short"])}</div>'
            f'<div class="ap-where"><span class="path">{E(where(f))}</span><span class="btn small" data-toast="GitHub\'s Files changed view would scroll to this line">{ic("crosshair", "size-3.5")}Show in diff</span></div></div>'
            f'<p class="ap-short">{E(f["gist"])}</p>'
            f'<div class="ap-do"><span class="label">What to do</span><p>{E(f["todo"])}</p></div>'
            f'<div class="ap-group" style="gap:0">{folds}</div>')
    main = {'fix': 'copy', 'block': 'copy', 'ask': 'post', 'note': ''}[f['sev']]
    copy_toast = 'Copied. Paste it to your coding agent.'

    def act(kind, label, cap, attrs):
        return f'<div class="ap-act" {attrs}><span class="btn{" primary" if main == kind else ""}">{label}</span><span class="cap">{cap}</span></div>'

    bar_a = ('<div class="ap-bar" data-panel="c-actions:A">'
             + act('copy', 'Copy fix prompt', 'for your coding agent', f'data-toast="{copy_toast}"')
             + act('post', 'Comment on GitHub', 'you see it first', f'data-to="post-{f["id"]}"')
             + act('dismiss', 'Dismiss', 'hide it, teach Airlock', f'data-to="dismiss-{f["id"]}"') + '</div>')
    if main == 'post':
        first = f'<span class="btn primary" style="flex:1" data-to="post-{f["id"]}">{ic("message-square", "size-3.5")}Comment on GitHub</span>'
    else:
        first = f'<span class="btn primary" style="flex:1" data-toast="{copy_toast}">{ic("copy", "size-3.5")}Copy fix prompt</span>'
    bar_b = f'<div class="ap-bar" data-panel="c-actions:B" hidden>{first}<span class="btn" data-to="more-{f["id"]}">More {ic("chevron-up", "size-3.5")}</span></div>'
    return (f'<div class="screen ap" data-id="{f["id"]}" data-device="phone" data-name="Finding: {E(f["short"])}" data-route="Side panel"{" data-pack" if f["id"] == "f1" else ""}>{CHROME}'
            f'{back_head("Review", nav)}<div class="flex-1 min-h-0 overflow-y-auto ap-body" data-scroll>{body}</div>{bar_a}{bar_b}</div>')


def comment_text(f):
    return f'**{f["short"]}**\n\n{f["happens"]}\n\n{f["why"]}\n\nSuggested: {f["todo"]}'


def post_sheet(f):
    if f['inline']:
        dest = (f'<div class="ap-dest">{ic("message-square")}<div><b>On the line</b><p>{E(f["path"])}, line {f["line"]}. It shows in Files changed, next to the code.</p>'
                '<p class="muted" style="text-decoration:underline;cursor:pointer" data-toast="The comment would move to the review summary">Put it in the summary instead</p></div></div>')
    else:
        dest = (f'<div class="ap-dest">{ic("file-text")}<div><b>In the review summary</b><p>{E(f["why_summary"])} The comment names the file and line.</p></div></div>')
    return (f'<div class="overlay" data-id="post-{f["id"]}" data-device="phone" data-name="Comment preview"{" data-pack" if f["id"] in ("f1", "f3") else ""}>'
            '<div class="ap-scrim" data-close data-scrim></div><div class="ap-sheet" data-sheet>'
            '<div class="ap-sheet-title">Comment on GitHub</div>'
            f'<span class="label">Where it goes</span>{dest}'
            f'<span class="label">The exact text</span><div class="quote" style="max-height:170px;overflow:auto">{E(comment_text(f))}</div>'
            f'<p class="muted">Posts as {PR["login"]} on {PR["repo"]}#{PR["n"]}, as a comment. Airlock never approves, requests changes or merges. Nothing has been sent yet.</p>'
            '<div style="display:flex;gap:8px"><span class="btn" data-toast="The text would become editable, and the preview would update">Edit text</span>'
            '<span class="btn primary" style="flex:1" data-close data-toast="Posted 1 comment. The finding shows Posted with a link.">Post comment</span></div>'
            '<span class="btn" data-close>Cancel</span></div></div>')


def post_many():
    items = ''.join(
        f'<div class="ap-set" style="cursor:default"><div class="grow"><b>{E(BY[i]["short"])}</b><span class="muted">On the line · {E(where(BY[i]))}</span></div></div>' for i in ('f1', 'f2'))
    return ('<div class="overlay" data-id="post-many" data-device="phone" data-name="Comment preview, several">'
            '<div class="ap-scrim" data-close data-scrim></div><div class="ap-sheet" data-sheet>'
            '<div class="ap-sheet-title">Comment on GitHub: 2 comments</div>'
            f'<span class="label">Where they go</span><div>{items}</div>'
            f'<p class="muted">Posted together as one review by {PR["login"]}, as comments. Open each to read or edit its exact text. Nothing has been sent yet.</p>'
            '<span class="btn primary wide" data-close data-toast="Posted 2 comments">Post 2 comments</span><span class="btn" data-close>Cancel</span></div></div>')


def dismiss_sheet(f):
    def opt(value, title, cap, default=False):
        return (f'<div class="ap-opt{" on" if default else ""}" data-tabs="why" data-tab="{value}" data-label="{E(title)}" data-on="on" data-off=""{" data-default" if default else ""}>'
                f'<span class="ap-radio"></span><div><b>{E(title)}</b><p class="muted">{E(cap)}</p></div></div>')
    line = f'Flagged "{f["short"]}" in {f["path"]}. Wrong because: '
    return (f'<div class="overlay" data-id="dismiss-{f["id"]}" data-device="phone" data-name="Dismiss"{" data-pack" if f["id"] == "f1" else ""}>'
            '<div class="ap-scrim" data-close data-scrim></div><div class="ap-sheet" data-sheet>'
            '<div class="ap-sheet-title">Dismiss this finding</div>'
            '<p>It leaves this review. Nothing is sent to GitHub. You can bring it back under More.</p>'
            '<span class="label">Why?</span>'
            + opt('mistaken', 'The finding is mistaken', 'Airlock saves a line so the same mistake is not made again.', True)
            + opt('fact', 'The code is right for a reason Airlock could not know', 'Saved as a fact about your product.')
            + opt('hide', 'Hide it on this pull request only', 'Nothing is saved.')
            + f'<div data-panel="why:mistaken|fact" class="ap-group"><span class="label">The line Airlock will remember</span><div class="quote">{E(line)}<span style="opacity:.55">finish the sentence here</span></div>'
              '<p class="muted">Airlock reads this line in every later review of this repository. You can remove it in Settings.</p></div>'
            '<div style="display:flex;gap:8px"><span class="btn" data-close>Cancel</span>'
            '<span class="btn primary" style="flex:1" data-close data-toast="Dismissed. It is under More, with Restore.">Dismiss</span></div></div></div>')


def more_sheet(f):
    return (f'<div class="overlay" data-id="more-{f["id"]}" data-device="phone" data-name="More actions">'
            '<div class="ap-scrim" data-close data-scrim></div><div class="ap-sheet" data-sheet>'
            '<div class="ap-sheet-title">More for this finding</div>'
            f'<div class="ap-set" data-close data-toast="Copied. Paste it to your coding agent.">{ic("copy")}<div class="grow"><b>Copy fix prompt</b><span class="muted">Instructions for your coding agent.</span></div></div>'
            f'<div class="ap-set" data-to="post-{f["id"]}" data-replace>{ic("message-square")}<div class="grow"><b>Comment on GitHub</b><span class="muted">You see the exact text and where it goes before anything is sent.</span></div></div>'
            f'<div class="ap-set" data-to="dismiss-{f["id"]}" data-replace>{ic("eye-off")}<div class="grow"><b>Dismiss</b><span class="muted">Hides it here and teaches Airlock. Nothing goes to GitHub.</span></div></div>'
            '<span class="btn" data-close>Close</span></div></div>')


def tour(n):
    dots = '<div class="ap-dots">' + ''.join(f'<i class="{"on" if i == n else ""}"></i>' for i in (1, 2, 3)) + '</div>'
    if n == 1:
        pic = ('<div class="ap-preview"><div class="ap-chips"><span class="ap-chip sev-fix">1 to fix</span><span class="ap-chip sev-ask">3 questions</span></div>'
               '<div class="ap-row" style="border:0;min-height:0;padding:2px 0;cursor:default"><span class="ap-sev sev-fix">Fix</span><div class="ap-row-main"><span class="ap-row-title">Tests pass without testing the safety rules</span></div></div></div>')
        title, text = 'Start at the top', 'The verdict says whether this can merge. Under it, each finding is one line. Tap a line for the short version; the detail is folded below it.'
    elif n == 2:
        pic = ('<div class="ap-group" style="gap:8px">'
               f'<div class="ap-where">{ic("copy")}<p><b>Copy fix prompt</b> copies instructions for your coding agent.</p></div>'
               f'<div class="ap-where">{ic("message-square")}<p><b>Comment on GitHub</b> shows you the exact text and where it goes: on the line, or in the review summary. It posts only when you press Post.</p></div>'
               f'<div class="ap-where">{ic("eye-off")}<p><b>Dismiss</b> hides the finding here and teaches Airlock. Nothing goes to GitHub.</p></div></div>')
        title, text = 'Three things you can do with a finding', ''
    else:
        pic = ''
        title, text = 'Notes and size', 'Open findings also appear as private notes under their lines on GitHub\'s Files changed page. Settings changes the text and button size, and shows this tour again.'
    nxt = (f'<span class="btn primary" style="flex:1" data-to="tour{n + 1}" data-replace>Next</span>' if n < 3
           else '<span class="btn primary" style="flex:1" data-close>Done</span>')
    skip = '<span class="btn" data-close>Skip</span>' if n < 3 else ''
    return (f'<div class="overlay" data-id="tour{n}" data-device="phone" data-name="Tour, step {n} of 3"{" data-pack" if n == 2 else ""}>'
            '<div class="ap-scrim" data-close data-scrim></div><div class="ap-sheet" data-sheet>'
            f'<span class="label">Step {n} of 3</span><div class="ap-sheet-title">{E(title)}</div>'
            + (f'<p>{E(text)}</p>' if text else '') + pic + dots
            + f'<div style="display:flex;gap:8px">{skip}{nxt}</div></div></div>')


def ready():
    def seg(group, items, default):
        return '<div class="ap-seg">' + ''.join(
            f'<span class="{"on" if v == default else ""}" data-tabs="{group}" data-tab="{v}" data-label="{E(lab)}" data-on="on" data-off=""{" data-default" if v == default else ""}>{E(lab)}</span>'
            for v, lab in items) + '</div>'
    depth = (seg('depth', [('quick', 'Quick'), ('standard', 'Standard'), ('deep', 'Deep')], 'standard')
             + '<p class="muted" data-panel="depth:quick" hidden>One pass, no second opinion. For small changes. About 1 to 2 minutes.</p>'
             + '<p class="muted" data-panel="depth:standard">Every finding is challenged before you see it. About 3 to 8 minutes.</p>'
             + '<p class="muted" data-panel="depth:deep" hidden>Standard, plus a closer second pass over each layer. About 10 to 20 minutes.</p>')
    body = (f'<div class="ap-verdict"><span class="label">Pull request</span><div class="ap-title">{E(PR["title"])}</div>'
            f'<p class="muted">{PR["repo"]} #{PR["n"]} · 14 files · 612 lines added, 38 removed</p></div>'
            f'<div class="ap-group"><span class="label">Depth</span>{depth}</div>'
            '<div class="ap-set" data-to="packs"><div class="grow"><b>Packs</b><span class="muted">Extensions, Generic</span></div>' + ic('chevron-right') + '</div>')
    bar = ('<div class="ap-bar" style="flex-direction:column;gap:4px"><span class="btn primary wide" data-to="running">Review this pull request</span>'
           '<span class="muted" style="text-align:center">Runs on your Claude login. Nothing is posted to GitHub.</span></div>')
    return (f'<div class="screen ap" data-id="ready" data-device="phone" data-name="Start a review" data-route="Side panel, before a review" data-pack>{CHROME}{HEAD}'
            f'<div class="flex-1 min-h-0 overflow-y-auto ap-body" data-scroll>{body}</div>{bar}</div>')


def running():
    steps = [('Done', 'ok', 'Reading the change'), ('Done', 'ok', 'Grouping connected files'), ('Done', 'ok', 'Writing what it does'),
             ('Now', 'ask', 'Looking for problems'), ('Next', 'note', 'Challenging each finding'), ('Next', 'note', 'Ranking and summing up')]
    lst = ''.join(f'<div class="ap-where"><span class="ap-sev sev-{s}" style="flex-basis:40px">{w}</span><span>{E(t)}</span></div>' for w, s, t in steps)
    body = ('<div class="ap-verdict"><span class="label">Reviewing</span><div class="ap-title">Looking for problems</div>'
            '<div class="ap-progress"><i></i></div><p class="muted">Step 4 of 6 · 2 min 10 s · 14 files in 3 groups</p></div>'
            + fold('steps', 'Show the steps', '6', f'<div class="ap-group">{lst}</div>')
            + '<p class="muted" data-root="home" style="border:1px dashed var(--border);border-radius:8px;padding:10px;cursor:pointer">In this prototype, tap here to see the finished review.</p>')
    bar = '<div class="ap-bar"><span class="btn wide" data-root="ready" data-toast="The review would stop">Stop</span></div>'
    return (f'<div class="screen ap" data-id="running" data-device="phone" data-name="Reviewing" data-route="Side panel, while a review runs">{CHROME}{HEAD}'
            f'<div class="flex-1 min-h-0 overflow-y-auto ap-body" data-scroll>{body}</div>{bar}</div>')


def settings():
    sizes = [('s', 'Small', '0.9'), ('m', 'Default', '1'), ('l', 'Large', '1.15'), ('xl', 'Largest', '1.3')]
    seg = '<div class="ap-seg">' + ''.join(
        f'<span class="{"on" if v == "m" else ""}" data-tabs="size" data-tab="{v}" data-label="{lab}" data-on="on" data-off=""{" data-default" if v == "m" else ""}>{lab}</span>' for v, lab, _ in sizes) + '</div>'
    sample = ('<div class="ap-row" style="border:0;min-height:0;padding:0;cursor:default"><span class="ap-sev sev-fix">Fix</span><div class="ap-row-main">'
              '<span class="ap-row-title">Tests pass without testing the safety rules</span><span class="ap-row-sub">tests/safety.test.js:14</span></div></div>'
              '<div style="display:flex;gap:8px"><span class="btn primary">Copy fix prompt</span><span class="btn">Dismiss</span></div>')
    previews = ''.join(f'<div class="ap-preview" data-panel="size:{v}"{"" if v == "m" else " hidden"} style="zoom:{z}">{sample}</div>' for v, _, z in sizes)

    def setrow(title, cap, right, attrs=''):
        return f'<div class="ap-set" {attrs}><div class="grow"><b>{E(title)}</b><span class="muted">{E(cap)}</span></div>{right}</div>'
    go = ic('chevron-right', 'size-4 ap-go')
    body = ('<span class="label">Display</span>'
            f'<div class="ap-group" data-id="size"><b>Text and button size</b>{seg}{previews}<p class="muted">Changes everything in the panel: text, buttons and spacing. Saved on this computer.</p></div>'
            '<span class="label" style="margin-top:6px">On GitHub</span>'
            + setrow('Notes in the diff', 'Private notes under the lines of Files changed. Only you see them.', '<span class="ap-switch"></span>', 'data-toast="Notes would turn off"')
            + '<span class="label" style="margin-top:6px">Reviews</span>'
            + setrow('Default depth', 'Standard', go, 'data-toast="Quick, Standard or Deep"')
            + setrow('Packs and learned lines', '2 packs for this repository · 4 lines learned', go, 'data-to="packs"')
            + '<span class="label" style="margin-top:6px">Help</span>'
            + setrow('Show the tour again', 'Three short steps.', go, 'data-to="tour1"')
            + setrow('Service', 'Running · paired · Claude found · GitHub signed in', go, 'data-toast="Service details and Check again would open"'))
    return (f'<div class="screen ap" data-id="settings" data-device="phone" data-name="Settings" data-route="Side panel" data-pack>{CHROME}'
            f'{back_head("Back", SCREEN_TITLE.format("Settings"))}'
            f'<div class="flex-1 min-h-0 overflow-y-auto ap-body" data-scroll>{body}</div></div>')


def packs():
    def pack(title, cap):
        return f'<div class="ap-set" data-toast="At least one pack stays on"><div class="grow"><b>{E(title)}</b><span class="muted">{E(cap)}</span></div><span class="ap-switch"></span></div>'
    learned = [('Mistake', 'Flagged "Button colour differs from the style guide". Wrong because: the extension has its own palette.'),
               ('Fact', 'Schedulers are allowed to call customers from any record they can open.'),
               ('Mistake', 'Flagged a missing permission for tel: links. Wrong because: tel: links need none.'),
               ('Fact', 'A very long line to show what happens when a learned line runs past two rows of text in a panel this narrow, which real lines often do.')]
    rows = ''.join(f'<div class="ap-set" style="align-items:flex-start;cursor:default"><div class="grow" style="gap:2px"><span class="ap-tag sev-note" style="align-self:flex-start">{k}</span>'
                   f'<span style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">{E(t)}</span></div>'
                   '<span class="btn small" data-toast="The line would be removed">Remove</span></div>' for k, t in learned)
    body = ('<span class="label">Packs for this repository</span>'
            + pack('Extensions', 'The tech team\'s extension standard, downloaded at review time.') + pack('Generic', 'Correctness checks for any repository.')
            + f'<span class="label" style="margin-top:6px">What Airlock learned · 4</span>{rows}'
            + '<p class="muted">Lines come from findings you dismissed. Airlock reads them in every later review of this repository.</p>')
    return (f'<div class="screen ap" data-id="packs" data-device="phone" data-name="Packs and learned lines" data-route="Side panel">{CHROME}'
            f'{back_head("Back", SCREEN_TITLE.format("Packs"))}'
            f'<div class="flex-1 min-h-0 overflow-y-auto ap-body" data-scroll>{body}</div></div>')


INFO = '''<div id="info">
  <h1>Airlock panel, simpler</h1>
  <p class="lede">The side panel leads with the answer, keeps every finding to one line, and puts the detail one tap away, with a size setting and a three-step tour.</p>
  <p class="muted">A design to react to before the extension is rebuilt. The phone-sized frame stands in for Chrome's side panel (390 wide). Every name and number is invented; nothing here talks to GitHub.</p>
  <button type="button" class="pt-open" data-open="home tour1">Open the prototype</button>
  <h2>What's in it</h2>
  <div class="pt-screens">
    <button type="button" data-open="home tour1"><b>First-run tour</b><span>Three steps, then the review</span></button>
    <button type="button" data-open="home"><b>Review</b><span>Verdict, then one line per finding</span></button>
    <button type="button" data-open="home f1"><b>One finding</b><span>Summary, what to do, three actions</span></button>
    <button type="button" data-open="home f1 post-f1"><b>Comment preview</b><span>Says it goes on the line</span></button>
    <button type="button" data-open="home f3 post-f3"><b>Comment in the summary</b><span>When the line is not in the change</span></button>
    <button type="button" data-open="home f1 dismiss-f1"><b>Dismiss</b><span>What it saves, and that nothing is sent</span></button>
    <button type="button" data-open="home settings"><b>Settings</b><span>Size, notes, packs, the tour</span></button>
    <button type="button" data-open="ready"><b>Start a review</b><span>Depth, then one button</span></button>
    <button type="button" data-open="home2"><b>After a push</b><span>Fixed, still open, new</span></button>
  </div>
  <h2>Decisions</h2>
  <p class="muted">Try this in the prototype switches the prototype to that option so you can click through it. Then pick the one you want.</p>
  <div class="decision" data-key="c-split" data-variant data-default="A" data-short="Layout" data-path="home" data-device="phone"><h3>How is the rest of the review kept out of the way?</h3><div class="opts">
    <div class="opt" data-choice="A" data-label="Three tabs" data-rec><b>Three tabs</b><span>Findings, The change, More. Each tab is short, and the findings never scroll away under other sections.</span></div>
    <div class="opt" data-choice="B" data-label="One page, folded"><b>One page, folded</b><span>Everything on one scroll, closed until opened. Nothing hidden behind a tab, but a longer page.</span></div>
  </div><!-- /decision --></div>
  <div class="decision" data-key="c-actions" data-variant data-default="A" data-short="Actions" data-path="home f1" data-device="phone"><h3>How are a finding's actions shown?</h3><div class="opts">
    <div class="opt" data-choice="A" data-label="Three buttons with a line each" data-rec><b>Three buttons with a line each</b><span>Copy fix prompt, Comment on GitHub and Dismiss always in view, each saying what it does.</span></div>
    <div class="opt" data-choice="B" data-label="One button and More"><b>One button and More</b><span>The likeliest action is big; the other two sit in a menu with longer explanations.</span></div>
  </div><!-- /decision --></div>
  <div class="decision" data-key="c-summaries"><h3>Who writes the short titles and one-line summaries?</h3><div class="opts">
    <div class="opt" data-choice="A" data-label="One extra step in each review" data-rec><b>One extra step in each review</b><span>A small, fast model step at the end writes them in plain words. A few cents and a few seconds per review. Reviews made before this show cut-down text.</span></div>
    <div class="opt" data-choice="B" data-label="Cut the text that exists"><b>Cut the text that exists</b><span>No extra step or cost. The panel shows the first sentence of each finding, which is often long and technical.</span></div>
  </div><!-- /decision --></div>
</div><!-- /info -->
'''

REQS = '''<div id="requirements">
  <h1>Requirements</h1>
  <h2>Reading a review</h2>
  <ol>
    <li class="req" data-id="FR-001" data-open="home">The first screenful answers "can this merge, and what do I do": the verdict in words, one sentence, and counts by kind.</li>
    <li class="req" data-id="FR-002" data-open="home">Each finding is one row: its kind as a word, a title of at most 60 characters, and its place. No body text in the list.</li>
    <li class="req" data-id="FR-003" data-open="home">Everything else in the review (what the change does, questions, whose call, checks after merge, notes, dismissed, timing) sits out of the way with a count, and nothing shown today is removed.</li>
    <li class="req" data-id="FR-004" data-open="home f1">A finding opens on a summary of one or two sentences and What to do. What happens, why, the code, what else is involved and how sure it is are folded below.</li>
    <li class="req" data-id="FR-005" data-open="home2">After a push, the top says how many were fixed, are still open and are new, and each row says New or Still open.</li>
  </ol>
  <h2>Acting on a finding</h2>
  <ol>
    <li class="req" data-id="FR-006" data-open="home f1">Copy fix prompt, Comment on GitHub and Dismiss stay pinned at the bottom, each with a line saying what it does. The filled button follows the kind: copy for a fix, comment for a question.</li>
    <li class="req" data-id="FR-007" data-open="home f1 post-f1">Before anything is sent, the comment preview says where the comment goes: on the line, or in the review summary and why. It shows the exact text and the account it posts as.</li>
    <li class="req" data-id="FR-008" data-open="home f1 dismiss-f1">The dismiss sheet says nothing goes to GitHub, offers the three reasons, and shows the line Airlock will remember when one is saved.</li>
    <li class="req" data-id="FR-009" data-open="home">From the review, one button copies a single fix prompt for every fix. Select turns on checkboxes to copy or comment on several.</li>
  </ol>
  <h2>Settings and help</h2>
  <ol>
    <li class="req" data-id="FR-010" data-open="home settings">Settings has a size control with four steps that changes text, buttons and spacing together, saved on this computer.</li>
    <li class="req" data-id="FR-011" data-open="home settings">Notes in the diff, the default depth, packs and learned lines, and the service's state move into Settings. The header holds one button.</li>
    <li class="req" data-id="FR-012" data-open="home tour1">A three-step tour shows once, with the first finished review. Skip ends it for good. Settings shows it again.</li>
  </ol>
  <h2>Summaries</h2>
  <ol>
    <li class="req" data-id="FR-013" data-open="home">Each review ends with a step that writes, in plain words for someone who does not read the code: a short title and a one-line summary for every finding, and one sentence on what the change does. If that step fails the review still finishes and the panel shows cut-down text.</li>
    <li class="req" data-id="FR-014" data-open="home f1">The text posted to GitHub is the full finding, not the summary.</li>
  </ol>
  <h2>A narrow panel</h2>
  <ol>
    <li class="req" data-id="FR-015" data-open="home">Every screen works from 320 to 420 wide with no sideways scrolling. Buttons are at least 32 high, 40 in the pinned bars, at the Default size.</li>
    <li class="req" data-id="FR-016" data-open="home f1">Kind is always a word (Block, Fix, Ask, Note); colour is a second cue only.</li>
  </ol>
  <h2>Still open</h2>
  <ul>
    <li class="q">Does the tour show with the first finished review (drawn here) or as soon as the panel is paired?</li>
    <li class="q">Is "Dismiss" the right word, given one of its three reasons only hides the finding on this pull request?</li>
  </ul>
</div><!-- /requirements -->
'''

parts = [INFO, REQS, home(), ready(), running(), home_push()]
for i, fid in enumerate(ORDER):
    parts.append(detail(BY[fid], i, len(ORDER)))
parts.append(detail(BY['f8'], 0, 1))
for f in F:
    parts += [post_sheet(f), dismiss_sheet(f), more_sheet(f)]
parts += [post_many(), tour(1), tour(2), tour(3), settings(), packs()]
OUT.write_text('\n'.join(parts) + '\n', encoding='utf-8')
print(OUT, len(OUT.read_text(encoding='utf-8')), 'characters')
