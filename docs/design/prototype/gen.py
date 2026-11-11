#!/usr/bin/env python3
"""Writes sections.html for the Airlock prototype from one invented pull request."""
import html
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sections.html")
esc = html.escape

# ---------------------------------------------------------------- data (all invented)
PR = dict(repo="moxie-portal", num=231, title="Shift swap requests", lines="1,380", files=23, commits=4,
          branch="feature/orbit-512-shift-swaps", head="3f9c2ab", head2="8d41e07")

FINDINGS = [
    dict(n=1, sev="Block", head="A manager can approve a swap for someone outside their own entity",
         file="app/src/lib/actions/shift-swaps.ts", short="lib/actions/shift-swaps.ts", line=88,
         src="Raj's standard", rule="Enforce on the write, not the picker",
         happens="A manager in one entity who has a request's link, or its id, can approve a swap for a technician in another. The list they pick from is filtered, but the save is not.",
         why="approveSwap() checks the role and loads the request, then updates it. Nothing between those steps checks that this manager may act on the requester. The picker on the page is scoped, which hides the gap in normal use.",
         fix="Call assertCanActOn(auth, swap.requesterId) before the update, the way approveTimeOff() does at line 64 of time-off.ts.",
         checked="Looked for a guard in the caller, the route and the middleware: none. Not on the base branch: the function is new in this PR.",
         comment="approveSwap updates the request without checking the manager can act on this person, so a manager in another entity can approve it with the id. can we call assertCanActOn before the update, like approveTimeOff does?",
         fixed="Fixed in 8d41e07",
         diff=[(84, "export async function approveSwap(swapId: string) {"),
               (85, '  const auth = await requireRole("manager");'),
               (86, "  const swap = await prisma.shiftSwap.findUniqueOrThrow({ where: { id: swapId } });"),
               (87, "  // the manager picked this request from their own list"),
               (88, "  await prisma.shiftSwap.update({"),
               (89, "    where: { id: swapId },"),
               (90, '    data: { status: "approved", approvedById: auth.employee.id },'),
               (91, "  });"),
               (92, '  await notifySwapDecision(swap, "approved");'),
               (93, "}")]),
    dict(n=2, sev="Fix", head="Shift swaps are switched on for every entity, not just Arizona Operations",
         file="app/prisma/migrations/0162_shift_swaps/migration.sql", short="migrations/0162_shift_swaps/migration.sql", line=41,
         src="Raj's standard", rule="New features launch for Arizona Operations only",
         happens="The day this ships, every entity gets the Shift swaps page, including ones whose managers have not been told it exists.",
         why="The seed inserts an EntityFeature row for each row in Entity. The agreed shape, used by migration 0121, seeds Arizona Operations by name and leaves V1_DEFAULTS off.",
         fix="Filter the seed with WHERE e.name = 'Arizona Operations' and set V1_DEFAULTS.shiftSwaps to false.",
         checked="V1_DEFAULTS.shiftSwaps is true in this PR. No other migration in the PR narrows the seed.",
         comment="this seeds shift swaps on for every entity. should be Arizona Operations only for now, same shape as 0121, with V1_DEFAULTS off",
         fixed="Fixed in 8d41e07",
         diff=[(36, 'CREATE INDEX "shift_swaps_requester_idx" ON "shift_swaps" ("requester_id");'),
               (37, ""),
               (38, "-- switch the feature on"),
               (39, 'INSERT INTO "EntityFeature" ("entityId", "feature", "enabled")'),
               (40, "SELECT e.id, 'shift_swaps', true"),
               (41, 'FROM "Entity" e;')]),
    dict(n=3, sev="Fix", head="If the reminder job runs long it is cut off, and nobody is told which reminders were missed",
         file="app/src/app/api/cron/shift-swap-reminders/route.ts", short="api/cron/shift-swap-reminders/route.ts", line=11,
         src="Your pack", rule="Sibling check: compare with the closest existing cron",
         happens="On a busy morning the job stops part-way. Some technicians get a reminder and some do not, and the run still looks fine.",
         why="The route sets no maxDuration and sends reminders one at a time in a loop. The closest existing cron, announcement-emails, sets maxDuration to 300 and records a run that stopped early.",
         fix="Set maxDuration = 300, and record how many reminders were due and how many were sent, so a short run shows.",
         checked="Compared with api/cron/announcement-emails/route.ts. The loop has no time limit per send.",
         comment="no maxDuration here and reminders go out one at a time. what happens when it gets cut off part-way? the announcements cron sets 300 and records a short run, can this do the same",
         fixed="Fixed in 5c0e2d1",
         diff=[(8, 'export const dynamic = "force-dynamic";'),
               (9, ""),
               (10, "// runs every morning at 7:00"),
               (11, "export async function GET(req: Request) {"),
               (12, "  if (!isCronAuthorized(req)) return unauthorized();"),
               (13, "  const due = await findSwapsNeedingReminder();"),
               (14, "  for (const swap of due) await sendSwapReminder(swap);"),
               (15, "  return Response.json({ ok: true });"),
               (16, "}")]),
    dict(n=4, sev="Ask", head="Who decided a swap request closes after 48 hours?",
         file="app/src/lib/shift-swaps/rules.ts", short="lib/shift-swaps/rules.ts", line=7,
         src="Raj's standard", rule="Whose call is this",
         happens="A technician who asks on Friday evening finds the request closed on Monday morning, before a manager has seen it.",
         why="expiresAfterHours is set to 48 in code. The PR description and the ticket do not say who chose it, and it is a rule about people's shifts.",
         fix="Confirm the number with whoever owns scheduling, and say so in the PR. If it should vary by entity, move it to settings.",
         checked="Searched the PR body, ORBIT-512 and docs/plans for the number: no owner named.",
         comment="who decided 48 hours? a friday evening request would close before monday. that's an ops call, can we confirm with the scheduling owner",
         fixed="Still open",
         diff=[(4, "// a request nobody answers is closed automatically"),
               (5, "export const SWAP_RULES = {"),
               (6, "  maxOpenPerPerson: 2,"),
               (7, "  expiresAfterHours: 48,"),
               (8, "};")]),
    dict(n=5, sev="Note", head="For a few minutes after a release, the Shift swaps page reads a table that is not there yet",
         file="app/src/app/(app)/shift-swaps/page.tsx", short="app/(app)/shift-swaps/page.tsx", line=19,
         src="Raj's standard", rule="Release timing goes in the brief, not in a comment",
         happens="Anyone who opens the page between the deploy and the migration sees an error. It clears by itself once the migration runs.",
         why="Migrations are applied by CI after the deploy. The page queries shift_swaps with no guard for the gap.",
         fix="Nothing to change in this PR. Worth knowing on release day.",
         checked="The same window exists for every PR that adds a table; the standard keeps it in the brief.",
         comment="",
         fixed="Kept in the brief",
         diff=[(16, "export default async function ShiftSwapsPage() {"),
               (17, '  const auth = await requireRole("employee");'),
               (18, "  const scope = await getScope(auth);"),
               (19, "  const swaps = await listSwaps(auth, scope);"),
               (20, "  return <SwapList swaps={swaps} canApprove={scope.act.length > 0} />;"),
               (21, "}")]),
]

ALSO = [
    ("Fix", "A declined request never tells the technician why", "components/shift-swaps/decline-dialog.tsx:44"),
    ("Fix", "The reminder says tomorrow for a shift that is two days away", "lib/shift-swaps/reminders.ts:23"),
    ("Note", "The swap list shows nothing at all when a team has no requests", "components/shift-swaps/swap-list.tsx:31"),
]
DROPPED = [
    ("listSwaps() reads without a scope", "Disproved", "scopeWhere is applied in the query at lib/queries/shift-swaps.ts:22."),
    ("Migration number 0162 may collide", "Left to CI", "Numbering is checked at PR #2, and the standard rates it a note at most."),
    ("No index on shift_swaps.status", "Too weak", "A small table. The standard treats a missing index as something to look into, not a finding."),
    ("Reminder emails skip the monitor copy", "Intended", "Raj's standard records this as deliberate for emails sent to a whole team."),
]
CLAIMS = [
    ("Managers only see their own entity's requests", "Verified", "scopeWhere at lib/queries/shift-swaps.ts:22"),
    ("Only the requester's manager can approve", "Not supported", "See finding 1"),
    ("Off by default until operations switch it on", "Not supported", "See finding 2"),
    ("No new environment variables", "Verified", "None in .env.example or src/env.ts"),
]
READ = [("migrations/0162_shift_swaps/migration.sql", 58, "Finding 2"), ("prisma/schema.prisma", 24, ""),
        ("lib/actions/shift-swaps.ts", 142, "Finding 1"), ("api/cron/shift-swap-reminders/route.ts", 61, "Finding 3"),
        ("lib/queries/shift-swaps.ts", 75, "")]
SKIM = [("lib/shift-swaps/rules.ts", 38, "Finding 4"), ("lib/shift-swaps/reminders.ts", 96, ""), ("lib/shift-swaps/notify.ts", 71, ""),
        ("app/(app)/shift-swaps/page.tsx", 44, "Finding 5"), ("components/shift-swaps/swap-list.tsx", 103, ""),
        ("components/shift-swaps/decline-dialog.tsx", 68, "")]
TREE = ["prisma/migrations/0162_shift_swaps/migration.sql", "prisma/schema.prisma", "src/app/(app)/shift-swaps/page.tsx",
        "src/app/api/cron/shift-swap-reminders/route.ts", "src/components/shift-swaps/decline-dialog.tsx",
        "src/components/shift-swaps/swap-list.tsx", "src/lib/actions/shift-swaps.ts", "src/lib/queries/shift-swaps.ts",
        "src/lib/shift-swaps/reminders.ts", "src/lib/shift-swaps/rules.ts"]

# ---------------------------------------------------------------- small pieces
BTN = "inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground h-9 px-3 text-[13px] font-medium"
BTN_O = "inline-flex items-center justify-center gap-1.5 rounded-md border bg-card h-9 px-3 text-[13px] font-medium"
BTN_S = "inline-flex items-center justify-center gap-1 rounded-md border bg-card h-7 px-2 text-[12px] font-medium"
CARD = "rounded-lg border bg-card p-3"
LABEL = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
PROTO = "inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground"
SEV = {"Block": "border-destructive text-destructive", "Fix": "border-foreground/50 text-foreground",
       "Ask": "border-primary text-primary", "Note": "text-muted-foreground"}
SEV_ICON = {"Block": "shield", "Fix": "wrench", "Ask": "message-circle", "Note": "file-text"}


def chip(sev):
    return (f'<span class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold {SEV[sev]}">'
            f'<i data-lucide="{SEV_ICON[sev]}" class="size-3"></i>{sev}</span>')


def src_chip(src):
    return f'<span class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{esc(src)}</span>'


def seg(group, items, default):
    out = ['<div class="flex rounded-md border bg-muted p-0.5 text-[12px]">']
    for value, label in items:
        d = " data-default" if value == default else ""
        out.append(f'<span class="flex-1 text-center rounded px-2 py-1" data-tabs="{group}" data-tab="{value}" data-label="{esc(label)}"'
                   f' data-on="bg-card shadow-sm font-semibold text-foreground" data-off="text-muted-foreground"{d}>{esc(label)}</span>')
    out.append("</div>")
    return "".join(out)


# ---------------------------------------------------------------- the GitHub page (left, simplified)
def host_top(active):
    def tab(name, extra=""):
        on = "border-b-2 border-primary font-semibold text-foreground" if name == active else "text-muted-foreground"
        return f'<span class="pb-2 {on}">{name}{extra}</span>'
    return f'''<!--chrome--><div class="h-9 shrink-0 border-b bg-muted flex items-center gap-2 px-6 text-[12px] text-muted-foreground"><span class="font-semibold text-foreground">{PR["repo"]}</span><span>/</span><span>Pull requests</span><span class="ml-auto">The GitHub page, simplified</span></div><!--/chrome-->
<div class="px-6 pt-4 shrink-0">
  <div class="text-[20px] font-semibold leading-7">{PR["title"]} <span class="text-muted-foreground font-normal">#{PR["num"]}</span></div>
  <div class="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground"><span class="rounded-full border px-2 py-0.5 text-foreground">Open</span><span>{PR["commits"]} commits into <span class="font-mono">{PR["branch"]}</span> from your fork</span></div>
  <div class="mt-3 flex gap-6 border-b text-[13px]">{tab("Conversation")}{tab("Commits", " 4")}{tab("Files changed", " 23")}</div>
</div>'''


def host_conversation():
    return f'''<div class="absolute inset-y-0 left-0 w-[966px] border-r bg-card overflow-hidden flex flex-col">
{host_top("Conversation")}
<div class="flex-1 min-h-0 px-6 py-4 flex flex-col gap-3 text-[13px] leading-5">
  <div class="rounded-md border">
    <div class="border-b bg-muted px-3 py-2 text-[12px] text-muted-foreground" data-panel="role:mine">You opened this pull request 6 minutes ago</div>
    <div class="border-b bg-muted px-3 py-2 text-[12px] text-muted-foreground" data-panel="role:theirs" hidden>A teammate opened this pull request 2 hours ago</div>
    <div class="p-4 space-y-2">
      <div class="font-semibold">What changed</div>
      <div>Technicians can ask to swap a shift with someone on their team. Their manager approves or declines, and a reminder goes out each morning for requests still waiting.</div>
      <div class="font-semibold pt-1">Claims</div>
      <div class="pl-4 text-muted-foreground space-y-0.5">{"".join(f"<div>• {esc(c[0])}</div>" for c in CLAIMS)}</div>
      <div class="font-semibold pt-1">Migrations</div>
      <div class="text-muted-foreground">0162_shift_swaps: new table shift_swaps, and the feature seed.</div>
      <div class="font-semibold pt-1">PR #1 developer self-review</div>
      <div class="text-muted-foreground">Not filled in yet.</div>
    </div>
  </div>
  <div class="rounded-md border p-4 flex items-center gap-3">
    <div class="flex-1"><div class="font-semibold">No checks ran on this pull request</div><div class="text-muted-foreground text-[12px]">This branch has no conflicts with the base branch.</div></div>
    <span class="{BTN_O}" data-toast="Hold the merge until Airlock shows a verdict">Merge pull request</span>
  </div>
</div>
</div>'''


def diff_rows(f, highlighted):
    rows = []
    for no, code in f["diff"]:
        hot = no == f["line"]
        cls, tag = "", ""
        if hot and highlighted:
            cls = " bg-primary/15 outline outline-2 -outline-offset-2 outline-primary"
            tag = f'<span class="shrink-0 mr-2 self-center rounded bg-primary text-primary-foreground px-1.5 font-sans text-[11px] leading-[18px]">Airlock {f["n"]}</span>'
        rows.append(f'<div class="flex{cls}"><span class="w-10 shrink-0 text-right pr-2 text-muted-foreground">{no}</span>'
                    f'<span class="w-5 shrink-0 text-center text-muted-foreground">+</span>'
                    f'<span class="whitespace-pre flex-1 min-w-0 overflow-hidden">{esc(code)}</span>{tag}</div>')
        if hot:
            rows.append(f'''<div data-panel="c-inline:B" hidden><div class="ml-14 mr-4 my-2 rounded-md border border-primary bg-card font-sans text-[12px] leading-5" data-id="note-{f["n"]}">
  <div class="flex items-center gap-2 border-b px-3 py-1.5 text-muted-foreground"><b class="text-foreground">Airlock</b><span>Only you can see this</span><span class="ml-auto">{chip(f["sev"])}</span></div>
  <div class="px-3 py-2"><div class="font-semibold text-[13px]">{esc(f["head"])}</div>
  <div class="mt-2 flex gap-2"><span class="{BTN_S}" data-toast="Fix prompt copied">Copy fix prompt</span><span class="{BTN_S}" data-to="finding-{f["n"]}">Open in the panel</span></div></div>
</div></div>''')
    return "".join(rows)


def host_files(f, highlighted):
    tree = "".join(
        f'<div class="truncate {"font-semibold text-foreground" if t.endswith(f["file"].split("/", 1)[1]) else "text-muted-foreground"}">{esc(t.split("/")[-1])}</div>'
        for t in TREE)
    return f'''<div class="absolute inset-y-0 left-0 w-[966px] border-r bg-card overflow-hidden flex flex-col">
{host_top("Files changed")}
<div class="flex-1 min-h-0 flex">
  <div class="w-[210px] shrink-0 border-r p-3 text-[12px] leading-6 overflow-hidden"><div class="{LABEL} mb-1">23 files</div>{tree}<div class="text-muted-foreground">and 13 more</div></div>
  <div class="flex-1 min-w-0 p-4 overflow-hidden">
    <div class="rounded-md border overflow-hidden">
      <div class="border-b bg-muted px-3 py-2 font-mono text-[12px] flex gap-2"><span class="truncate">{esc(f["file"])}</span><span class="ml-auto shrink-0 text-muted-foreground">new lines</span></div>
      <div class="font-mono text-[12px] leading-[22px] py-1">{diff_rows(f, highlighted)}</div>
    </div>
    <div class="mt-3 rounded-md border px-3 py-2 font-mono text-[12px] text-muted-foreground">The next file in the pull request</div>
  </div>
</div>
</div>'''


# ---------------------------------------------------------------- the Airlock panel (right)
def panel_head(status="Connected", packs_link=True):
    dot = "bg-primary" if status == "Connected" else "bg-destructive"
    link = (f'<span class="inline-flex items-center gap-1 text-[12px] text-primary" data-to="packs"><i data-lucide="settings" class="size-3.5"></i>Packs</span>'
            if packs_link else "")
    return f'''<!--chrome--><div class="ml-[966px] h-12 shrink-0 border-b bg-card flex items-center gap-2 px-4">
  <span class="grid place-items-center size-6 rounded bg-primary text-primary-foreground text-[12px] font-bold">A</span>
  <span class="font-semibold text-[14px]">Airlock</span>
  <span class="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"><span class="size-2 rounded-full {dot}"></span>{status}</span>
  {link}
</div>
<div class="ml-[966px] shrink-0 border-b bg-muted px-4 py-1.5 text-[12px] text-muted-foreground"><span class="text-foreground font-medium">{PR["repo"]} #{PR["num"]}</span> · PR #1: fork to org branch</div><!--/chrome-->'''


def screen(sid, name, host, body, foot="", status="Connected", packs_link=True, attrs="", foot_raw=""):
    footer = f'<div class="ml-[966px] shrink-0 border-t bg-card px-4 py-2 text-[11px] text-muted-foreground flex items-center gap-2">{foot}</div>' if foot else foot_raw
    route = f'github.com/…/{PR["repo"]}/pull/{PR["num"]}'
    return f'''<div class="screen bg-background text-foreground font-sans antialiased text-[13px] leading-5" data-id="{sid}" data-device="laptop" data-name="{esc(name)}" data-route="{route}"{attrs}>
{host}
{panel_head(status, packs_link)}
<div class="ml-[966px] flex-1 min-h-0 overflow-y-auto" data-scroll><div class="p-4 space-y-3">
{body}
</div></div>
{footer}
</div>
'''


def finding_card(f, state=None):
    status = ""
    if state:
        icon = "check" if state.startswith("Fixed") else "clock"
        status = f'<span class="inline-flex items-center gap-1 text-[11px] font-semibold"><i data-lucide="{icon}" class="size-3"></i>{esc(state)}</span>'
    box = '<span class="mt-0.5 grid place-items-center size-4 shrink-0 rounded border bg-primary text-primary-foreground"><i data-lucide="check" class="size-3"></i></span>' if f["n"] <= 3 and not state else \
          '<span class="mt-0.5 size-4 shrink-0 rounded border bg-card"></span>' if not state else ""
    return f'''<div class="{CARD} flex gap-2.5" data-to="finding-{f["n"]}" data-id="card-{f["n"]}">
  {box}
  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-1.5 flex-wrap">{chip(f["sev"])}{src_chip(f["src"])}{status}</div>
    <div class="mt-1 font-semibold leading-[18px]">{esc(f["head"])}</div>
    <div class="mt-0.5 font-mono text-[11px] text-muted-foreground truncate">{esc(f["short"])}:{f["line"]}</div>
  </div>
  <i data-lucide="chevron-right" class="size-4 shrink-0 self-center text-muted-foreground"></i>
</div>'''


def brief_block():
    claims = "".join(
        f'<div class="py-1.5 border-b last:border-0"><div>{esc(c)}</div><div class="text-[12px] text-muted-foreground"><span class="font-semibold {"text-foreground" if v == "Verified" else "text-destructive"}">{v}</span> · {esc(e)}</div></div>'
        for c, v, e in CLAIMS)
    return f'''<div class="{CARD}"><div class="{LABEL}">What this does</div>
  <div class="mt-1 space-y-1"><div>Adds a shift_swaps table and a Shift swaps page behind a feature gate.</div><div>Technicians ask; a manager approves or declines; both get an email.</div><div>A cron sends a reminder each morning for requests still waiting.</div><div>Requests nobody answers close after 48 hours.</div></div></div>
<div class="{CARD}"><div class="{LABEL}">Claims in the PR description</div><div class="mt-1">{claims}</div></div>
<div class="{CARD}"><div class="{LABEL}">Questions for you</div>
  <div class="mt-1 space-y-1"><div>• What should a technician see when a swap is approved after the shift has started?</div><div>• Can the same shift sit in two open requests?</div></div></div>
<div class="{CARD}"><div class="{LABEL}">Whose call is this</div><div class="mt-1">The 48-hour expiry (finding 4) belongs to whoever owns scheduling.</div></div>
<div class="{CARD}"><div class="{LABEL}">Check on staging after merge</div>
  <div class="mt-1 space-y-1"><div>1. As a manager in a second entity, open an approval link from the first. It should be refused.</div><div>2. As a technician, ask for a swap and check the manager gets one email, not two.</div><div>3. Switch the feature off for one entity and check its address is refused, not just hidden.</div></div></div>
<div class="{CARD}"><div class="{LABEL}">Self-review text for the PR body</div>
  <div class="mt-1 rounded border bg-muted px-2 py-1.5 font-mono text-[11px] leading-4">Reviewed with Airlock at {PR["head"]} (Standard, Orbit pack). 5 findings: 1 block, 2 fixes, 1 question for ops, 1 release note. No checks ran at PR #1.</div>
  <div class="mt-2"><span class="{BTN_S}" data-toast="Self-review text copied"><i data-lucide="copy" class="size-3"></i>Copy self-review</span></div></div>'''


def files_block():
    def tag(t):
        return f'<span class="rounded bg-muted px-1.5 text-[11px]">{t}</span>' if t else ""

    def rows(items):
        return "".join(
            f'<div class="flex items-center gap-2 py-1.5 border-b last:border-0" data-toast="Jumps to this file in the diff"><span class="font-mono text-[11px] truncate flex-1">{esc(p)}</span>'
            f'{tag(t)}<span class="text-[11px] text-muted-foreground w-12 text-right">{n} lines</span></div>'
            for p, n, t in items)
    return f'''<div class="{CARD}"><div class="flex items-baseline gap-2"><div class="{LABEL}">Read these yourself</div><span class="ml-auto text-[11px] text-muted-foreground">5 files · 360 lines · about 14 min</span></div>
  <div class="mt-1 text-[12px] text-muted-foreground">Migrations, permissions, anything that writes data or sends email.</div><div class="mt-1">{rows(READ)}</div></div>
<div class="{CARD}"><div class="flex items-baseline gap-2"><div class="{LABEL}">Skim</div><span class="ml-auto text-[11px] text-muted-foreground">6 files · 420 lines</span></div>
  <div class="mt-1 text-[12px] text-muted-foreground">Business logic and data shaping. Airlock read these in full.</div><div class="mt-1">{rows(SKIM)}</div></div>
<div class="{CARD}"><div class="flex items-baseline gap-2"><div class="{LABEL}">Trust</div><span class="ml-auto text-[11px] text-muted-foreground">12 files · 600 lines</span></div>
  <div class="mt-1 text-[12px] text-muted-foreground">9 test files and 3 layout components. Tests exist for every file in the two lists above.</div></div>'''


def verdict_tabs(findings_html):
    return f'''{seg("view", [("findings", "Findings"), ("brief", "Brief"), ("files", "Files")], "findings")}
<div data-panel="view:findings"><div class="space-y-3">{findings_html}</div></div>
<div data-panel="view:brief" hidden><div class="space-y-3">{brief_block()}</div></div>
<div data-panel="view:files" hidden><div class="space-y-3">{files_block()}</div></div>'''


# ---------------------------------------------------------------- screens
def s_ready():
    body = f'''<div class="{CARD}"><div class="{LABEL}">This pull request</div>
  <div class="mt-1 font-semibold">{PR["title"]}</div>
  <div class="text-[12px] text-muted-foreground">{PR["lines"]} changed lines in {PR["files"]} files · {PR["commits"]} commits</div>
  <div class="mt-2 rounded border bg-muted px-2 py-1.5 text-[12px]"><b>No checks ran here.</b> Lint, types and tests only run on PRs into staging.</div></div>
<div class="{CARD}" data-id="rules"><div class="flex items-center gap-2"><div class="font-semibold">Orbit pack</div><div class="ml-auto w-[120px]">{seg("pack", [("on", "On"), ("off", "Off")], "on")}</div></div>
  <div data-panel="pack:on"><div class="mt-2 text-[12px] text-muted-foreground">On by itself because this repo is moxie-portal.</div>
    <div class="mt-2 space-y-1.5 text-[12px]"><div class="flex gap-2"><span class="font-semibold w-[104px] shrink-0">Raj's standard</span><span class="text-muted-foreground">Loaded as it is from his repo. Synced today, 9:12 am.</span></div><div class="flex gap-2"><span class="font-semibold w-[104px] shrink-0">Your pack</span><span class="text-muted-foreground">14 rules, 10 things learned from dismissals.</span></div><div class="flex gap-2"><span class="font-semibold w-[104px] shrink-0">Generic rules</span><span class="text-muted-foreground">Always on underneath.</span></div></div></div>
  <div data-panel="pack:off" hidden><div class="mt-2 text-[12px] text-muted-foreground">Generic rules only: this repo's CLAUDE.md and AGENTS.md, plus the built-in checks for bugs, security and data. This is what every other repo gets.</div></div></div>
<div class="{CARD}" data-id="depth"><div class="font-semibold">Depth</div><div class="mt-2">{seg("depth", [("quick", "Quick"), ("standard", "Standard"), ("deep", "Deep")], "standard")}</div>
  <div data-panel="depth:quick" hidden><div class="mt-2 text-[12px] text-muted-foreground">About 2 minutes. What the PR does, which files to read, and obvious problems. One pass, and findings are not challenged.</div></div>
  <div data-panel="depth:standard"><div class="mt-2 text-[12px] text-muted-foreground">About 10 minutes for this PR. Four lenses and the sibling check, then every finding is challenged before you see it.</div></div>
  <div data-panel="depth:deep" hidden><div class="mt-2 text-[12px] text-muted-foreground">20 minutes or more. Standard, then a second pass over each layer. For very large PRs.</div></div></div>
<span class="{BTN} w-full" data-to="running" data-id="run"><i data-lucide="send" class="size-4"></i>Run review</span>
<div class="text-[12px] text-muted-foreground text-center">Nothing is posted to GitHub unless you click Post.</div>'''
    return screen("ready", "Ready", host_conversation(), body, attrs=" data-start data-pack")


def s_running():
    def step(word, text, sub=""):
        icon = {"Done": "check", "Working": "refresh-cw", "Waiting": "clock"}[word]
        tone = "text-foreground" if word != "Waiting" else "text-muted-foreground"
        more = f'<span class="text-muted-foreground"> · {sub}</span>' if sub else ""
        return (f'<div class="flex gap-2 py-1"><span class="inline-flex items-center gap-1 w-[76px] shrink-0 text-[11px] font-semibold {tone}"><i data-lucide="{icon}" class="size-3"></i>{word}</span>'
                f'<span class="{tone}">{text}{more}</span></div>')
    body = f'''<div class="{CARD}"><div class="flex items-center gap-2"><div class="font-semibold">Reviewing</div><span class="text-[12px] text-muted-foreground">3 min 40 s of about 10</span><span class="ml-auto {BTN_S}" data-back>Cancel</span></div>
  <div class="mt-2 h-1.5 rounded-full bg-muted"><div class="h-1.5 w-[38%] rounded-full bg-primary"></div></div>
  <div class="mt-2">{step("Done", "Got the PR and checked out the branch")}{step("Done", "Sorted 23 files", "5 to read, 6 to skim, 12 to trust")}{step("Done", "Worked out what the PR does")}
  {step("Done", "Boundary and security", "2 possible")}{step("Working", "Numbers and data")}{step("Working", "Scale and more entities")}{step("Done", "Release safety", "1 possible")}{step("Waiting", "Sibling check", "your pack")}
  {step("Waiting", "Challenge every finding")}{step("Waiting", "Rank and pick the top five")}</div></div>
<div class="{LABEL}">Ready now</div>
<div class="{CARD}"><div class="{LABEL}">What this does</div>
  <div class="mt-1 space-y-1"><div>Adds a shift_swaps table and a Shift swaps page behind a feature gate.</div><div>Technicians ask; a manager approves or declines; both get an email.</div><div>A cron sends a reminder each morning for requests still waiting.</div></div></div>
<div class="{CARD}"><div class="flex items-baseline gap-2"><div class="{LABEL}">Read these yourself</div><span class="ml-auto text-[11px] text-muted-foreground">5 files · 360 lines</span></div>
  <div class="mt-1">{"".join(f'<div class="flex items-center gap-2 py-1.5 border-b last:border-0" data-toast="Jumps to this file in the diff"><span class="font-mono text-[11px] truncate flex-1">{esc(p)}</span><span class="text-[11px] text-muted-foreground">{n} lines</span></div>' for p, n, _ in READ)}</div></div>
<span class="{PROTO}" data-to="verdict" data-replace>Prototype only: skip to the finished review</span>'''
    return screen("running", "Running", host_conversation(), body, attrs=" data-pack")


def verdict_body():
    cards = "".join(finding_card(f) for f in FINDINGS)
    also = "".join(
        f'<div class="flex gap-2 py-1.5 border-b last:border-0" data-toast="Opens like the findings above">{chip(s)}<div class="min-w-0"><div class="leading-[18px]">{esc(h)}</div><div class="font-mono text-[11px] text-muted-foreground truncate">{esc(p)}</div></div></div>'
        for s, h, p in ALSO)
    findings = f'''<div class="flex items-center gap-2 text-[12px]"><span class="text-muted-foreground">3 selected</span><span class="ml-auto {BTN_S}" data-toast="One fix prompt for 3 findings copied" data-id="copy-all"><i data-lucide="copy" class="size-3"></i>Copy fix prompt</span><span class="{BTN_S}" data-to="post-all" data-id="post-all-btn">Post 3</span></div>
{cards}
<div class="{CARD}"><div class="flex items-center gap-2" data-toggle="also"><div class="font-semibold">Also found</div><span class="text-[12px] text-muted-foreground">3 more that held up, ranked lower</span><i data-lucide="chevron-down" class="ml-auto size-4 text-muted-foreground"></i></div>
  <div data-toggled="also" hidden><div class="mt-1">{also}</div></div></div>
<div class="text-[12px] text-muted-foreground">4 possible findings were dropped. <span class="text-primary underline underline-offset-2" data-to="dropped">See why</span></div>'''
    banner = f'''<div class="rounded-lg border border-destructive bg-card p-3" data-id="verdict">
  <div class="flex items-center gap-2"><i data-lucide="shield" class="size-5 text-destructive"></i><div class="text-[16px] font-semibold" data-panel="role:mine">Not ready</div><div class="text-[16px] font-semibold" data-panel="role:theirs" hidden>Request changes</div></div>
  <div class="mt-1" data-panel="role:mine">Fix 2 things before you merge. The first lets a manager approve a swap outside their own entity.</div>
  <div class="mt-1" data-panel="role:theirs" hidden>2 things to fix first. The first lets a manager approve a swap outside their own entity.</div>
  <div class="mt-2 flex gap-1.5 flex-wrap text-[11px] text-muted-foreground"><span>1 Block</span><span>·</span><span>2 Fix</span><span>·</span><span>1 Ask</span><span>·</span><span>1 Note</span></div></div>'''
    return banner + verdict_tabs(findings)


def s_verdict():
    foot = f'<span>Reviewed {PR["head"]} · Standard · 9 min 12 s</span><span class="ml-auto {PROTO}" data-to="pushed">Prototype only: push fixes</span>'
    return screen("verdict", "Verdict", host_files(FINDINGS[0], False), verdict_body(), foot, attrs=" data-pack")


def s_finding(f):
    n = f["n"]
    prev_ = f'<span class="{BTN_S}" data-to="finding-{n - 1}" data-replace><i data-lucide="chevron-left" class="size-3"></i>Previous</span>' if n > 1 else ""
    next_ = f'<span class="{BTN_S}" data-to="finding-{n + 1}" data-replace>Next<i data-lucide="chevron-right" class="size-3"></i></span>' if n < len(FINDINGS) else ""
    def b(kind, cls, role):
        grow = " flex-1" if cls is BTN else ""
        if kind == "copy":
            return f'<span class="{cls}{grow}" data-toast="Fix prompt copied. Paste it into the Claude session on this branch." data-id="copy-{n}-{role}"><i data-lucide="copy" class="size-4"></i>Copy fix prompt</span>'
        if kind == "post":
            return f'<span class="{cls}{grow}" data-to="post-{n}" data-id="post-{n}-{role}"><i data-lucide="send" class="size-4"></i>Post comment</span>'
        return f'<span class="{cls}" data-to="dismiss" data-id="dismiss-{n}-{role}">Dismiss</span>'
    note = ""
    if f["comment"]:
        mine = b("copy", BTN, "mine") + b("post", BTN_O, "mine") + b("dismiss", BTN_O, "mine")
        theirs = b("post", BTN, "theirs") + b("copy", BTN_O, "theirs") + b("dismiss", BTN_O, "theirs")
    else:
        mine = b("copy", BTN, "mine") + b("dismiss", BTN_O, "mine")
        theirs = b("copy", BTN, "theirs") + b("dismiss", BTN_O, "theirs")
        note = '<div class="text-[12px] text-muted-foreground">No Post button: the standard keeps release-timing notes in your brief, not on the PR.</div>'
    foot_raw = (f'<div class="ml-[966px] shrink-0 border-t bg-card px-4 py-3" data-id="actions-{n}">'
                f'<div data-panel="role:mine"><div class="flex gap-2">{mine}</div></div>'
                f'<div data-panel="role:theirs" hidden><div class="flex gap-2">{theirs}</div></div></div>')
    body = f'''<div class="flex items-center gap-2"><span class="inline-flex items-center gap-1 text-primary text-[12px]" data-back><i data-lucide="chevron-left" class="size-3.5"></i>Findings</span><span class="ml-auto text-[12px] text-muted-foreground">{n} of 5</span>{prev_}{next_}</div>
<div class="{CARD}" data-id="detail-{n}">
  <div class="flex items-center gap-1.5 flex-wrap">{chip(f["sev"])}{src_chip(f["src"])}</div>
  <div class="mt-1.5 text-[15px] font-semibold leading-5">{esc(f["head"])}</div>
  <div class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{esc(f["file"])}:{f["line"]}</div>
  <div class="mt-3 {LABEL}">What happens</div><div class="mt-0.5">{esc(f["happens"])}</div>
  <div class="mt-3 {LABEL}">Why</div><div class="mt-0.5">{esc(f["why"])}</div>
  <div class="mt-3 {LABEL}">Suggested change</div><div class="mt-0.5">{esc(f["fix"])}</div>
  <div class="mt-3 {LABEL}">How it was checked</div><div class="mt-0.5 text-muted-foreground">{esc(f["checked"])}</div>
  <div class="mt-3 text-[12px] text-muted-foreground">Rule: {esc(f["rule"])}</div>
</div>
{note}'''
    return screen(f"finding-{n}", f"Finding {n}", host_files(f, True), body, attrs=" data-pack" if n == 1 else "", foot_raw=foot_raw)


def sheet(oid, name, inner, attrs=""):
    return f'''<div class="overlay font-sans antialiased text-[13px] leading-5 text-foreground" data-id="{oid}" data-device="laptop" data-name="{esc(name)}"{attrs}>
  <div class="absolute inset-y-0 right-0 w-[400px] bg-black/50" data-close data-scrim></div>
  <div class="absolute right-0 bottom-0 w-[400px] max-h-[700px] overflow-hidden rounded-t-xl border-t bg-card p-4 space-y-3" data-sheet>
{inner}
  </div>
</div>
'''


def o_dismiss():
    def opt(value, label, line):
        d = " data-default" if value == "intended" else ""
        return (f'<div class="rounded-md border p-2.5" data-tabs="why" data-tab="{value}" data-label="{label}" data-on="border-primary bg-primary/10" data-off="bg-card"{d}>'
                f'<div class="font-semibold">{label}</div><div class="text-[12px] text-muted-foreground">{line}</div></div>')
    inner = f'''<div class="text-[15px] font-semibold">Dismiss this finding</div>
<div class="space-y-2">{opt("wrong", "Wrong", "Airlock misread the code.")}{opt("intended", "Intended", "A product decision Airlock did not know about.")}{opt("notnow", "Not now", "Real, but not for this PR.")}</div>
<div data-panel="why:wrong" hidden><div class="{LABEL}">What did it get wrong?</div><div class="mt-1 rounded-md border bg-background px-2 py-1.5 min-h-[52px]">The check is already made in the layout above this action.</div><div class="mt-1 text-[12px] text-muted-foreground">Saved to your pack as a dated line. Airlock uses it from the next review, and you can undo it under Packs.</div></div>
<div data-panel="why:intended"><div class="{LABEL}">What should Airlock know?</div><div class="mt-1 rounded-md border bg-background px-2 py-1.5 min-h-[52px]">Swap requests close after 48 hours. Set by the scheduling owner.</div><div class="mt-1 text-[12px] text-muted-foreground">Saved to moxie-portal's product knowledge in your pack. Airlock uses it from the next review, and you can undo it under Packs.</div></div>
<div data-panel="why:notnow" hidden><div class="rounded-md border bg-muted px-2 py-1.5 text-[12px]">Hidden on this PR only. Nothing is saved, so it comes back on the next PR if it is still true.</div></div>
<div class="flex gap-2"><span class="{BTN} flex-1" data-close data-toast="Dismissed. You can undo it under Packs." data-id="dismiss-ok">Dismiss</span><span class="{BTN_O}" data-close>Cancel</span></div>'''
    return sheet("dismiss", "Dismiss", inner)


def comment_box(f):
    return f'''<div class="rounded-md border" data-id="comment-{f["n"]}"><div class="border-b bg-muted px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground truncate">{esc(f["short"])}, line {f["line"]}</div>
  <div class="px-2.5 py-2">{esc(f["comment"])}</div>
  <div class="border-t px-2.5 py-1.5 text-[12px]"><span class="text-primary underline underline-offset-2" data-toast="The text becomes editable here">Edit</span></div></div>'''


def post_buttons(count):
    word = "comment" if count == 1 else "comments"
    return f'''<div data-panel="c-post:A"><div class="text-[12px] text-muted-foreground">Goes live on PR #{PR["num"]} as you, straight away.</div>
  <div class="mt-2 flex gap-2"><span class="{BTN} flex-1" data-close data-toast="Posted to PR #{PR["num"]}">Post {count} {word}</span><span class="{BTN_O}" data-close>Cancel</span></div></div>
<div data-panel="c-post:B" hidden><div class="text-[12px] text-muted-foreground">Saved on GitHub as a draft review only you can see, until you press Submit there.</div>
  <div class="mt-2 flex gap-2"><span class="{BTN} flex-1" data-close data-toast="Saved as a draft review. Submit it on GitHub.">Save {count} as a draft</span><span class="{BTN_O}" data-close>Cancel</span></div></div>'''


def o_post(f):
    inner = f'''<div class="text-[15px] font-semibold">Post to GitHub</div>
<div class="text-[12px] text-muted-foreground">This is the exact text. Nothing has been sent yet.</div>
{comment_box(f)}
{post_buttons(1)}'''
    return sheet(f'post-{f["n"]}', "Post preview", inner, f' data-over="finding-{f["n"]}"')


def o_post_all():
    inner = f'''<div class="text-[15px] font-semibold">Post 3 comments to GitHub</div>
<div class="text-[12px] text-muted-foreground">This is the exact text. Nothing has been sent yet.</div>
<div class="space-y-2 max-h-[430px] overflow-hidden">{"".join(comment_box(f) for f in FINDINGS[:3])}</div>
{post_buttons(3)}'''
    return sheet("post-all", "Post all selected", inner, ' data-over="verdict"')


def o_dropped():
    rows = "".join(
        f'<div class="py-2 border-b last:border-0"><div class="font-semibold">{esc(h)}</div><div class="text-[12px] text-muted-foreground"><span class="font-semibold text-foreground">{w}</span> · {esc(why)}</div></div>'
        for h, w, why in DROPPED)
    inner = f'''<div class="flex items-center"><div class="text-[15px] font-semibold">Dropped: 4</div><span class="ml-auto {BTN_S}" data-close>Close</span></div>
<div class="text-[12px] text-muted-foreground">Raised by a lens, then removed. Kept here so you can see nothing was hidden.</div>
<div>{rows}</div>'''
    return sheet("dropped", "Dropped findings", inner, ' data-over="verdict"')


def s_pushed():
    cards = "".join(finding_card(f) for f in FINDINGS)
    body = f'''<div class="rounded-lg border border-primary bg-card p-3" data-id="pushed-banner">
  <div class="flex items-center gap-2"><i data-lucide="refresh-cw" class="size-4 text-primary"></i><div class="font-semibold">2 new commits since this review</div></div>
  <div class="mt-1 text-[12px] text-muted-foreground">{PR["head"]} to {PR["head2"]}. Airlock looks only at what changed, and checks each finding below again.</div>
  <div class="mt-2"><span class="{BTN} w-full" data-to="verdict2" data-id="rereview"><i data-lucide="refresh-cw" class="size-4"></i>Re-review the changes, about 3 min</span></div></div>
<div class="{LABEL}">From the earlier commit</div>
<div class="space-y-3 opacity-60">{cards}</div>'''
    foot = f'<span>Last reviewed {PR["head"]} · the PR is now at {PR["head2"]}</span>'
    return screen("pushed", "After a push", host_files(FINDINGS[0], False), body, foot, attrs=" data-pack")


def s_verdict2():
    cards = "".join(finding_card(f, f["fixed"]) for f in FINDINGS)
    body = f'''<div class="rounded-lg border border-primary bg-card p-3" data-id="verdict2">
  <div class="flex items-center gap-2"><i data-lucide="check" class="size-5 text-primary"></i><div class="text-[16px] font-semibold">Ready for PR #2</div></div>
  <div class="mt-1">All 3 fixes landed. One question is still open for operations, and nothing new turned up in the 2 new commits.</div>
  <div class="mt-2 flex gap-1.5 flex-wrap text-[11px] text-muted-foreground"><span>3 Fixed</span><span>·</span><span>1 Still open</span><span>·</span><span>1 Kept in the brief</span></div></div>
{cards}
<div class="{CARD}"><div class="{LABEL}">Self-review text for the PR body</div>
  <div class="mt-1 rounded border bg-muted px-2 py-1.5 font-mono text-[11px] leading-4">Reviewed with Airlock at {PR["head2"]} (Standard, Orbit pack). 3 findings fixed in this PR. Open for ops: the 48-hour expiry. Release note: the page reads shift_swaps before the migration runs. No checks ran at PR #1.</div>
  <div class="mt-2"><span class="{BTN_S}" data-toast="Self-review text copied" data-id="copy-self"><i data-lucide="copy" class="size-3"></i>Copy self-review</span></div></div>
<div class="text-[12px] text-muted-foreground text-center">Merge PR #1 on the left when you are ready. Airlock never merges or approves.</div>'''
    foot = f'<span>Reviewed {PR["head2"]} · changes only · 2 min 51 s</span>'
    return screen("verdict2", "Ready for PR #2", host_files(FINDINGS[0], False), body, foot, attrs=" data-pack")


def s_packs():
    def pack(name, tag, lines, extra=""):
        return (f'<div class="{CARD}"><div class="flex items-center gap-2"><div class="font-semibold">{name}</div><span class="ml-auto rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{tag}</span></div>'
                f'<div class="mt-1 space-y-0.5 text-[12px] text-muted-foreground">{"".join(f"<div>{l}</div>" for l in lines)}</div>{extra}</div>')
    learned = [("8 Nov", "Intended", "Coaching notes are visible to the person's own manager chain on purpose."),
               ("6 Nov", "Wrong", "Flagged an unscoped read in a file that only runs inside the payroll sync."),
               ("5 Nov", "Intended", "Team leads may edit a shift up to its start time.")]
    rows = "".join(
        f'<div class="py-1.5 border-b last:border-0"><div class="flex items-center gap-2 text-[11px] text-muted-foreground"><span>{d}</span><span class="font-semibold text-foreground">{k}</span><span class="ml-auto text-primary underline underline-offset-2" data-toast="Entry removed. Airlock stops using it.">Undo</span></div><div class="text-[12px]">{esc(t)}</div></div>'
        for d, k, t in learned)
    body = f'''<div class="flex items-center gap-2"><span class="inline-flex items-center gap-1 text-primary text-[12px]" data-back><i data-lucide="chevron-left" class="size-3.5"></i>Back</span><div class="font-semibold text-[15px]">Packs and settings</div></div>
<div class="{LABEL}">Rule packs</div>
{pack("Raj's standard", "Read only", ["From the moxie-review-kit repo, main branch.", "Last changed 3 Nov. Synced today, 9:12 am.", "Used for moxie-portal."])}
{pack("Your pack", "Yours to edit", ["14 rules, among them the sibling check.", "10 things learned from dismissals: 4 Wrong, 6 Intended.", "Plain files in the airlock-reviews repo."], f'<div class="mt-2"><span class="{BTN_S}" data-toast="Opens the pack folder on this Mac">Open the files</span></div>')}
{pack("Generic", "Built in", ["Bugs, security, data and error handling.", "Reads a repo's own CLAUDE.md and AGENTS.md.", "Used for every other repo."])}
{pack("Extensions", "Later", ["Your extension review rules, for the five extension repos.", "Those repos get the generic rules until then."])}
<div class="{LABEL}">Learned from dismissals</div>
<div class="{CARD}">{rows}<div class="pt-2 text-[12px] text-primary underline underline-offset-2" data-toast="Shows all 10 entries">Show all 10</div></div>
<div class="{LABEL}">Reviews</div>
<div class="{CARD} space-y-1.5 text-[12px]"><div class="flex"><span class="text-muted-foreground w-[120px]">Default depth</span><span>Standard</span></div><div class="flex"><span class="text-muted-foreground w-[120px]">Small PRs</span><span>Quick, under 200 changed lines</span></div><div class="flex"><span class="text-muted-foreground w-[120px]">Starts</span><span>When you click Run review</span></div><div class="flex"><span class="text-muted-foreground w-[120px]">Runs on</span><span>Your Claude login on this Mac</span></div></div>
<div class="{LABEL}">Service</div>
<div class="{CARD} text-[12px]"><div class="flex items-center gap-1.5"><span class="size-2 rounded-full bg-primary"></span><span class="font-semibold">Running on this Mac</span><span class="text-muted-foreground">· starts at login</span></div>
  <div class="mt-2"><span class="{PROTO}" data-to="offline">Prototype only: what you see if it stops</span></div></div>'''
    return screen("packs", "Packs and settings", host_conversation(), body, packs_link=False, attrs=" data-pack")


def s_offline():
    body = f'''<div class="rounded-lg border border-destructive bg-card p-3" data-id="offline">
  <div class="flex items-center gap-2"><i data-lucide="x" class="size-5 text-destructive"></i><div class="text-[15px] font-semibold">Airlock's service is not running</div></div>
  <div class="mt-1">The panel needs it to read the repository and run a review. It lives on this Mac and normally starts at login.</div>
  <div class="mt-2 {LABEL}">Start it</div>
  <div class="mt-1 rounded border bg-muted px-2 py-1.5 font-mono text-[12px]">airlock start</div>
  <div class="mt-3 flex gap-2"><span class="{BTN} flex-1" data-back data-toast="Connected"><i data-lucide="refresh-cw" class="size-4"></i>Try again</span></div></div>
<div class="{CARD} text-[12px]"><div class="font-semibold text-[13px]">Reviews you already ran are still here</div><div class="mt-1 text-muted-foreground">The last review of this PR was at {PR["head"]}.</div>
  <div class="mt-2"><span class="{BTN_S}" data-to="verdict" data-replace>Show the last review</span></div></div>'''
    return screen("offline", "Service not running", host_conversation(), body, status="Not connected", packs_link=False)


# ---------------------------------------------------------------- info, roles, requirements
INFO = '''<div id="info">
  <h1>Airlock</h1>
  <p class="lede">Review a pull request in a panel beside the GitHub page, and fix what matters before Raj sees it.</p>
  <p class="muted">First draft for you to click through. The GitHub page on the left is a simplified stand-in, and the pull request, files and findings are invented. Buttons that would copy or post only show a message.</p>
  <button type="button" class="pt-open" data-open="ready">Open the prototype</button>
  <h2>What's in it</h2>
  <div class="pt-screens">
    <button type="button" data-open="ready"><b>Ready</b><span>The Orbit switch, depth, Run review</span></button>
    <button type="button" data-open="ready running"><b>Running</b><span>What it is doing, and what is ready early</span></button>
    <button type="button" data-open="ready verdict"><b>Verdict</b><span>Top five, also found, brief, files</span></button>
    <button type="button" data-open="ready verdict finding-1"><b>One finding</b><span>The line, the reason, the fix prompt</span></button>
    <button type="button" data-open="ready verdict finding-4 dismiss"><b>Dismiss</b><span>Wrong, Intended or Not now</span></button>
    <button type="button" data-open="ready verdict finding-1 post-1"><b>Post preview</b><span>The exact text before anything is sent</span></button>
    <button type="button" data-open="ready verdict pushed"><b>After a push</b><span>Re-review only what changed</span></button>
    <button type="button" data-open="ready packs"><b>Packs and settings</b><span>Raj's standard, your pack, what it learned</span></button>
  </div>
  <h2>Decisions</h2>
  <p class="muted">Try this in the prototype switches the prototype to that option so you can click through it. Then pick the one you want.</p>
  <div class="decision" data-key="c-inline" data-variant data-default="A" data-short="In the diff" data-path="ready verdict finding-1"><h3>How does a finding show up in the diff?</h3><div class="opts">
    <div class="opt" data-choice="A" data-label="Highlight the line" data-rec><b>Highlight the line</b><span>The panel holds the finding and the line lights up when you jump to it. Part of the first build.</span></div>
    <div class="opt" data-choice="B" data-label="A private note under the line"><b>A private note under the line</b><span>Reads like a review comment only you can see. Comes after the panel, and can break when GitHub changes its page.</span></div>
  </div><!-- /decision --></div>
  <div class="decision" data-key="c-post" data-variant data-default="A" data-short="Posting" data-path="ready verdict finding-1 post-1"><h3>What does Post do?</h3><div class="opts">
    <div class="opt" data-choice="A" data-label="Post straight away" data-rec><b>Post straight away</b><span>After the preview, the comment is live on the PR.</span></div>
    <div class="opt" data-choice="B" data-label="Save a draft review"><b>Save a draft review</b><span>It waits on GitHub, visible only to you, until you press Submit there.</span></div>
  </div><!-- /decision --></div>
  <div class="decision" data-key="c-start"><h3>When does a review start?</h3><div class="opts">
    <div class="opt" data-choice="A" data-label="When you click Run review" data-rec><b>When you click Run review</b><span>Nothing runs, and no usage is spent, until you ask.</span></div>
    <div class="opt" data-choice="B" data-label="When you open one of your open PRs"><b>When you open one of your open PRs</b><span>The verdict is waiting sooner, but browsing spends usage.</span></div>
  </div><!-- /decision --></div>
</div><!-- /info -->

<div id="roles" data-default="mine">
  <span data-role="mine" data-label="My own PR" data-start="ready"></span>
  <span data-role="theirs" data-label="A teammate's PR" data-start="ready"></span>
</div>

<div id="requirements">
  <h1>Requirements</h1>
  <h2>Starting a review</h2>
  <ol>
    <li class="req" data-id="FR-001" data-open="ready">Airlock opens as a panel beside any GitHub pull request and says which stage the PR is at.</li>
    <li class="req" data-id="FR-002" data-open="ready">The Orbit pack switches on by itself for moxie-portal and can be switched off. Every other repo gets the generic rules.</li>
    <li class="req" data-id="FR-003" data-open="ready">Three depths: Quick, Standard and Deep. Standard is the default, and small PRs run Quick.</li>
    <li class="req" data-id="FR-004" data-open="ready running">While it runs, the panel shows each step in words, and shows what the PR does and which files to read before the findings are ready.</li>
  </ol>
  <h2>Findings</h2>
  <ol>
    <li class="req" data-id="FR-005" data-open="ready verdict">A verdict in words, then at most five ranked findings. Each has a severity word, what happens to a real person, the file and line, and which pack raised it.</li>
    <li class="req" data-id="FR-006" data-open="ready verdict">Every other finding that held up is under Also found. Dropped ones are listed with the reason.</li>
    <li class="req" data-id="FR-007" data-open="ready verdict finding-1">Opening a finding jumps the GitHub page to its line.</li>
    <li class="req" data-id="FR-008" data-open="ready verdict finding-1">A fix prompt can be copied for one finding or for all selected ones.</li>
    <li class="req" data-id="FR-009" data-open="ready verdict finding-4 dismiss">A finding can be dismissed as Wrong, Intended or Not now. Wrong and Intended are saved to your pack and used from the next review.</li>
    <li class="req" data-id="FR-010" data-open="ready verdict">The brief holds the claims check, questions, checks for staging and the self-review text for the PR body.</li>
  </ol>
  <h2>GitHub</h2>
  <ol>
    <li class="req" data-id="FR-011" data-open="ready verdict finding-1 post-1">Nothing is written to GitHub until you click Post, and you see the exact text first.</li>
    <li class="req" data-id="FR-012" data-open="ready verdict post-all">One comment or all selected can be posted in one go. Airlock never approves or merges.</li>
  </ol>
  <h2>After a push</h2>
  <ol>
    <li class="req" data-id="FR-013" data-open="ready verdict pushed">When the PR has new commits, the panel offers to re-review only what changed.</li>
    <li class="req" data-id="FR-014" data-open="ready verdict pushed verdict2">Each earlier finding is marked Fixed or Still open, and the verdict is updated.</li>
  </ol>
  <h2>Packs and service</h2>
  <ol>
    <li class="req" data-id="FR-015" data-open="ready packs">Raj's standard is loaded as it is and kept in step with his repo. Your pack is separate, and everything learned from dismissals can be undone.</li>
    <li class="req" data-id="FR-016" data-open="ready packs offline">If the service on this Mac is not running, the panel says so and how to start it.</li>
  </ol>
  <h2>Still open</h2>
  <ul>
    <li class="q">Lint, type-check and tests are not run by Airlock in the first version. That is how I read your answer; say if you meant it should run them.</li>
    <li class="q">The diff markers come after the panel in the build order, whichever option you pick.</li>
    <li class="q">Review times shown here are targets until the first real runs are measured.</li>
  </ul>
</div><!-- /requirements -->
'''

parts = [INFO, s_ready(), s_running(), s_verdict()]
parts += [s_finding(f) for f in FINDINGS]
parts += [s_pushed(), s_verdict2(), s_packs(), s_offline(), o_dismiss()]
parts += [o_post(f) for f in FINDINGS if f["comment"]]
parts += [o_post_all(), o_dropped()]
with open(OUT, "w") as fh:
    fh.write("\n".join(parts))
print("wrote", OUT, sum(len(p) for p in parts), "bytes")
