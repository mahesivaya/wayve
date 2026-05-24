# Wayve — Business Deep Dive

Companion to [wayve.md](wayve.md) (product overview) and
[technical_wayve.md](technical_wayve.md) (engineering deep dive). This
document is the commercial picture: market, pricing, GTM, unit economics,
risk register, and the founder-level strategic decisions that follow from
the product surface as it stands today.

**Style note.** Where Wayve has concrete commitments (the four pricing
tiers, the published API contract, the feature set), this doc cites them
verbatim. Where the founder still has decisions to make (specific revenue
targets, hiring sequence, fundraising timeline), the doc presents
*frameworks* and a recommended default with the trade-off called out —
not invented numbers. Sections marked **(founder fills in)** are decision
points where I don't have ground truth.

---

## 0. Table of contents

1. [Executive summary](#1-executive-summary)
2. [Product vision](#2-product-vision)
3. [Market: TAM, SAM, SOM](#3-market-tam-sam-som)
4. [Customer segments + ideal customer profile](#4-customer-segments--ideal-customer-profile)
5. [Competitive landscape](#5-competitive-landscape)
6. [Pricing strategy](#6-pricing-strategy)
7. [Unit economics](#7-unit-economics)
8. [Revenue model + projections](#8-revenue-model--projections)
9. [Go-to-market motion](#9-go-to-market-motion)
10. [Sales process](#10-sales-process)
11. [Product roadmap (12-month, 36-month)](#11-product-roadmap)
12. [Risk register](#12-risk-register)
13. [Compliance posture](#13-compliance-posture)
14. [Team & org structure](#14-team--org-structure)
15. [Funding strategy](#15-funding-strategy)
16. [Partnership opportunities](#16-partnership-opportunities)
17. [Customer success + support model](#17-customer-success--support-model)
18. [Brand + positioning](#18-brand--positioning)
19. [Key business metrics (KPIs)](#19-key-business-metrics-kpis)
20. [Investor narrative](#20-investor-narrative)
21. [Exit scenarios](#21-exit-scenarios)

---

## 1. Executive summary

**What Wayve is.** A unified workspace bundling email, chat, video calls,
scheduling, cloud drive, notes, tasks, and an AI assistant — sold by the
seat, deployable as SaaS or self-hosted, with end-to-end encryption on
the chat layer and a documented API surface with the patterns enterprise
buyers expect (RBAC, SCIM, OIDC SSO, audit log export, webhooks).

**The bet.** The mid-market (10-500-seat companies) is fragmenting their
spend across Google Workspace + Slack + Notion + Zoom + Calendly +
Linear — typically $50-$100 per seat per month across all tools, with
zero integration between them. Wayve replaces that mix at **$10 / seat /
month** with a single coherent product, real SSO + SCIM + audit
infrastructure, and chat encryption the megacorp suites don't offer.

**Why now.**

- **AI ratchet.** Every productivity-tool category just added LLM
  features. The winning AI surfaces will be the ones with deep workspace
  context — i.e., the suite, not the point tool. Wayve's Gemini bridge
  is a foothold; deeper integration is a 12-month roadmap item.
- **Privacy regulation tailwind.** Schrems II, GDPR rulings, and the
  EU AI Act each create demand for self-hostable / data-sovereign
  alternatives to US hyperscalers. Wayve's "self-host the whole thing
  on your own EC2" story is a real differentiator with EU buyers.
- **Productivity-tool consolidation fatigue.** Customer-success leaders
  at mid-market companies report 12-15 SaaS tools in a typical
  knowledge-worker stack. The market is primed for "one tool, one
  invoice, fewer integrations to maintain."

**The execution risk.** Wayve is *seven products in a trench coat*. Each
of those products has a market leader (Gmail, Slack, Google Calendar,
Google Drive, Notion, Linear, Zoom). Wayve has to be *good enough at
each* — and *meaningfully better at the bundle*. That's a hard product
bar.

**Current state (founder fills in).** Pre-launch / early-launch / X
paying customers / $Y MRR.

---

## 2. Product vision

### Three-sentence pitch

> Wayve is the single workspace tool a 100-person company needs to replace
> Gmail + Slack + Notion + Drive + Zoom + Calendly. We charge one bill
> instead of five. We ship the privacy, encryption, and audit primitives
> that decide enterprise procurement, on day one — not in a $20k/seat
> "Enterprise" tier.

### Product principles

1. **Bundle by default, unbundle by API.** Everything is in one app;
   nothing forces customers to use the parts they don't want.
   Programmatic access is the same price as the UI.
2. **End-to-end encryption where it matters.** Chat is E2E-encrypted
   end-to-end. Email and Drive are server-encrypted because the
   integrations require it (Gmail OAuth, file previews).
3. **Self-hostable.** A customer who can run Docker can run Wayve on
   their own VPC. The same binary serves SaaS and self-host.
4. **API contract is the marketing surface.** OpenAPI spec, dev portal
   tutorials, signed outbound webhooks, rate-limit tiers, SCIM, OIDC.
   The customer's developers should be able to evaluate Wayve without
   talking to sales.
5. **Honest defaults.** Pricing on the website. Limits documented.
   Failure modes documented. Audit gaps explicit, not hidden.

### What Wayve is *not*

- Not a tool for solo developers who already have Google Workspace and
  don't see the seat-multiplier pain yet.
- Not a tool for the Fortune 500. They have BAAs and FedRAMP and
  procurement cycles Wayve doesn't yet serve.
- Not the cheapest tool in the market. The free tier exists to seed
  developer integrations, not to be the consumer-grade competitor to
  Gmail.

---

## 3. Market: TAM, SAM, SOM

### TAM (Total Addressable Market)

The bundled productivity-suite market. Bounded by:

- **Productivity software market (Gartner 2024):** ~$430 B globally.
- **Collaboration software segment:** ~$50 B.
- **SMB + mid-market knowledge workers worldwide:** ~250 M seats × $10
  average ARPU/month = ~$30 B annual.

So Wayve's TAM is **on the order of $30 B / year** at full saturation.
This is a useful ceiling, not a forecast. Microsoft Teams alone is
estimated at $5-8 B ARR within Office 365.

### SAM (Serviceable Addressable Market)

Wayve realistically targets:

- English-speaking markets, year 1-2.
- Companies with 10-500 employees (out of ~7 M globally in this band).
- Knowledge-worker organizations (about 60% of the band).
- Companies with at least one IT/Ops person who can manage a bundled
  tool (excludes the smallest 10-person shops that just use Gmail).

Math: ~4.2 M companies × 50 average seats = **210 M seats** × $10 =
**$25 B annual SAM.**

### SOM (Serviceable Obtainable Market)

Year 1: 100 paying customers × 30 seats × $10 = **$360k ARR.**

This is a deliberate floor, not a forecast. It assumes:
- 100 customers obtainable via product-led growth + organic outbound.
- 30 average seats = mid of the 10-500 band, skewed toward small.
- 100% on Organization plan; no Enterprise yet.

Higher scenarios are plausible if PLG + dev-portal-led pull works
unusually well. See §8 for projections.

---

## 4. Customer segments + ideal customer profile

### Primary ICP (Tier-1 GTM focus)

**Privacy-conscious mid-market technology companies, 20-200 seats.**

- Examples: privacy-first SaaS shops, infosec consultancies, healthcare
  software ISVs, legal-tech firms, EU-based AI startups dodging US
  hyperscalers.
- Pain: they're stitching together Gmail + Slack + Notion + Drive +
  Zoom — five tools, five invoices, five SCIM connections, five
  surfaces with their own access reviews.
- Buying trigger: SOC 2 audit or annual procurement review forces them
  to enumerate everything an employee can access. Wayve replaces five
  rows on that spreadsheet with one.
- Champion: VPE / CTO / Head of IT. Often the same person who'd self-host
  if given the option.
- Decision cycle: 2-6 weeks.
- ACV: $10/seat × 50 seats × 12 months = **$6,000 ARR per logo.**

### Secondary ICP

**Engineering teams at larger companies that want a sandboxed alternative
for sensitive projects.**

- Examples: defense contractor team building classified comms; finance
  team handling MNPI; M&A working group inside Big Co.
- Pain: their existing Slack/Gmail is too leaky for the project.
- Buying trigger: a specific deal or initiative.
- Champion: project lead with budget authority.
- Decision cycle: weeks (project-budgeted).
- ACV: highly variable, $5k-$50k.

### Tertiary segment

**Personal power users** on the free + Advance tiers.

- Not the revenue base. The reason they matter: they're the developers
  who *evaluate* Wayve, write integrations against the API, and then
  pull it into their team.
- The free tier exists to make this funnel possible without sales
  contact.

### Anti-ICP (don't pursue)

- **Fortune 500.** Procurement = 9-18 months. Not viable until Wayve has
  SOC 2 Type II, BAAs, FedRAMP runway, and dedicated CSMs.
- **Consumer.** Free tier for personal use is a marketing tool, not a
  customer segment. Don't optimize for it.
- **Single-product replacements.** "We just want email" → recommend
  Fastmail. "We just want chat" → recommend Mattermost. Wayve's value is
  the bundle.

---

## 5. Competitive landscape

### Direct competitors

| Competitor | Strength | Wayve's edge |
| --- | --- | --- |
| **Google Workspace** ($6-18/seat/mo) | Brand, network effect, AI integration | Bundle includes chat + tasks + notes; E2E chat encryption; self-hostable; cheaper per-seat for mid-market |
| **Microsoft 365** ($6-22/seat/mo) | Enterprise penetration, Teams adoption | Same as above. Microsoft's audit story is great; Wayve's is good *and* the bundle is cheaper |
| **Zoho One** ($37/seat/mo) | True bundle, 40+ apps | Wayve is narrower (the 7 apps that matter), API-first, modern UI; Zoho is broader but slower-shipping |
| **Notion** ($8-15/seat/mo) | Best-in-class for docs/wiki | Wayve has no wiki yet — possible roadmap item; today they're complementary |

### Adjacent competitors (point tools)

| Tool | Replaced by Wayve's | Risk |
| --- | --- | --- |
| Slack | Chat | Slack's free tier is generous; their search is best-in-class |
| Gmail | Emails | Wayve syncs Gmail rather than replacing — interop, not displace |
| Zoom | Calls | Zoom's reliability bar is very high; Wayve uses Cloudflare TURN, not yet proven at scale |
| Calendly | Scheduler (in-app booking) | Calendly's external-facing booking page is more polished than Wayve's |
| Notion | Notes | Wayve's Notes is markdown-flat; Notion is a database/page hybrid — different categories |
| Linear | Tasks | Linear's project-management depth dwarfs Wayve's todo list; not a real overlap yet |
| Dropbox / Drive | Drive | Wayve's Drive is intentionally minimal; not a Dropbox replacement |

### The "good enough at each, better at the bundle" thesis

The honest competitive read: Wayve will not beat Slack at search, Notion
at databases, or Zoom at video reliability for at least 2-3 years. The
bet is that 80% of mid-market knowledge work doesn't need the best-
in-class for any one product — it needs *coherent enough* across all
of them, with one bill, one SSO, one audit log, one API.

That bet has been validated in the past: HubSpot beat Salesforce + Pardot
+ ZoomInfo by being good-enough at each with a unified data model.
Atlassian beat point tools with a bundle. Frontapp is bundling support +
email.

### Wayve's structural advantages

1. **API contract on day one.** Most competitors retrofit APIs years
   after the GUI ships. Wayve's API + OpenAPI + dev portal + webhook
   spec exists in v1.
2. **Encryption defaults.** Chat is E2E by contract, not opt-in. This
   is hard to retrofit and rare in the segment.
3. **Self-hosting is the same binary as SaaS.** No fork, no "Enterprise
   On-Prem" tier with a custom build.
4. **Single-founder simplicity.** Decisions land in days, not quarters.
   The negative is bus factor (see §12).

---

## 6. Pricing strategy

### The four tiers (ground truth from the codebase)

| Tier | Code | Price | Rate limit | Monthly API requests | Audience |
| --- | --- | --- | --- | --- | --- |
| Free | `basic_user` | $0 | 60/min | 50,000 | Personal eval, OSS contributors, individual developers |
| Advance | `advance_user` | $7/mo | 300/min | 500,000 | Hobby app builders, freelancers, weekend automations |
| Organization | `organization` | $10/seat/mo | 600/min | 5,000,000 | The primary revenue tier — 10-500 seat companies |
| Enterprise | `enterprise` | Custom | 6,000/min | Unlimited | 500+ seats, custom SLAs, on-prem |

### Pricing principles

**1. Per-seat for the Organization tier, period.** No usage-based for
the productivity-tool bundle. Customers pre-budget seats and don't want
surprise invoices.

**2. The free tier is for the API surface, not the productivity suite.**
A free-tier user gets the full UI; the constraint is the 60-req/min API
ceiling. This is intentional — power users discover Wayve's API quietly,
build a personal automation, then bring it to their team.

**3. Enterprise pricing is opaque on purpose.** "Custom" signals
high-touch sales involvement, custom SLAs, BAA, etc. Anchoring it to the
Organization tier × seat-count × some multiplier (typically 2-3x for
the SLA + dedicated CSM) is reasonable starting math.

**4. No free Organization tier (no team-of-N free plan).** Slack offers
free team plans up to 10 users; Wayve does not. The cost of supporting
free organization-shaped customers (RBAC requests, SCIM config help)
exceeds the conversion value.

### Pricing comparison

| Bundle | Per seat / month | What you get |
| --- | --- | --- |
| **Wayve Organization** | **$10** | Email + chat + calls + scheduler + drive + notes + tasks + AI + 5M API requests + SCIM + audit export + webhooks |
| Google Workspace Business Plus | $18 | Email + chat + calls + scheduler + drive (5 TB) + AI (Gemini) + S/MIME, AppSheet |
| Microsoft 365 Business Premium | $22 | Email + Teams + drive (1 TB) + Office apps + Intune endpoint mgmt |
| Slack Business+ | $15 | Just chat (search, channels, integrations, SAML) |
| Notion Business | $15 | Notes/wiki only |
| Stitched alternative for an equivalent stack | $50-100 | Multiple invoices, multiple SCIM configs |

Wayve's $10/seat undercuts every bundled competitor while *matching or
beating* on the enterprise primitives (SCIM, audit export, webhooks,
self-host) that procurement cares about.

### Pricing risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Big-tech bundle drops their price (Google going to $5) | Low (they make more from ads/data) | Wayve's encryption story is structurally different |
| Customers want à la carte (just chat) | Medium | Honest answer: that's not us; ship bundle-only |
| Free tier abuse (API farming) | Medium | Per-key + monthly quota; ban repeated abusers |
| Enterprise undercuts Org tier (12-seat enterprise contract at $8/seat) | High when sales gets hungry | Hold the line at $10 floor; offer term-discounts (annual upfront for 10%) instead |

---

## 7. Unit economics

### Per-customer math (Organization tier, founder-tweakable)

Assumptions:
- Avg customer: 50 seats.
- Price: $10/seat/month.
- ACV: 50 × $10 × 12 = **$6,000.**
- Average customer lifetime: 36 months (3 years).
- LTV: 6,000 × 3 = **$18,000.**
- Gross margin: ~80% (SaaS bundled tooling; below).
- LTV gross: **$14,400.**

### Cost structure per seat

| Cost component | Per seat / month | Notes |
| --- | --- | --- |
| AWS compute (EC2 + EBS) | $0.15 | Currently single instance; scales sublinearly |
| Postgres (managed RDS hypothetical) | $0.20 | Today: self-hosted on the same EC2. RDS = ~$50/mo flat / 50 seats = $1, but actually amortized lower |
| Bandwidth (egress) | $0.10 | Gmail + Outlook sync + webhook deliveries |
| Stripe fees | $0.30 | 2.9% + 30¢ per transaction, monthly billing |
| Gemini / OpenAI usage | $0.40 | Variable — power AI users push this up |
| **Variable COGS** | **$1.15** | ~11.5% of revenue |
| **Gross margin** | **88.5%** | |

These are *aspirational* and **founder-fills-in-actual** numbers — they
assume disciplined infra. Today's single-EC2 setup is more like $0.50/
seat with huge headroom.

### CAC (Customer Acquisition Cost)

Sales motion mix dictates CAC:

- **PLG (Product-Led Growth).** Free-tier developer signs up → uses API
  → invites team → upgrades to Org tier. CAC ~$200 (content / SEO
  amortized). 60-70% of acquisitions ideally.
- **Outbound sales.** Founder-led for the first 50 logos; SDR-led after.
  CAC ~$1,000-$2,500 / logo. Reserved for the higher-seat ICP.
- **Partner / referral.** Affiliate or implementation partner brings the
  lead. CAC = the referral fee (15-20%).
- **Paid acquisition (PPC/social).** Avoid in v1; SaaS PPC is brutally
  competitive in this space.

Blended CAC target year 1: **~$400 per logo.**

### CAC payback

ACV $6,000 ÷ gross margin 88.5% = $6,810 cash gross / year.
CAC $400 → payback = **2.4 months.**

This is healthy SaaS math. The number gets worse as outbound mix grows;
keep PLG > 50% of new ARR to keep CAC under control.

### LTV : CAC ratio

LTV $14,400 ÷ CAC $400 = **36 : 1.**

Above 3:1 is "viable SaaS." 5:1 is "good." 36:1 is "either the model is
wrong or there's massive room to invest more in acquisition." The
honest reading: assume CAC is more like $1,000 once you build a real
sales motion, putting LTV:CAC at ~14:1 — still excellent.

---

## 8. Revenue model + projections

Three projection scenarios. **None are forecasts** — they're stress
tests on the model. Founder fills in real numbers from actual pipeline.

### Conservative

| Period | Customers | Avg seats | MRR | ARR |
| --- | --- | --- | --- | --- |
| Month 6 | 25 | 20 | $5,000 | $60k |
| Month 12 | 75 | 25 | $18,750 | $225k |
| Month 18 | 175 | 28 | $49,000 | $588k |
| Month 24 | 320 | 30 | $96,000 | **$1.15M** |
| Month 36 | 700 | 32 | $224,000 | **$2.69M** |

### Realistic

| Period | Customers | Avg seats | MRR | ARR |
| --- | --- | --- | --- | --- |
| Month 6 | 40 | 25 | $10,000 | $120k |
| Month 12 | 150 | 30 | $45,000 | $540k |
| Month 18 | 380 | 32 | $121,600 | $1.46M |
| Month 24 | 720 | 35 | $252,000 | **$3.02M** |
| Month 36 | 1,500 | 40 | $600,000 | **$7.2M** |

### Optimistic (requires either AI tailwind or enterprise tier landing)

| Period | Customers | Avg seats | MRR | ARR |
| --- | --- | --- | --- | --- |
| Month 6 | 60 | 30 | $18,000 | $216k |
| Month 12 | 250 | 35 | $87,500 | $1.05M |
| Month 18 | 700 | 40 | $280,000 | $3.36M |
| Month 24 | 1,400 | 45 | $630,000 | **$7.56M** |
| Month 36 | 3,200 | 50 | $1,600,000 | **$19.2M** |

### Revenue mix at year 3

| Tier | % of customers | % of ARR |
| --- | --- | --- |
| Free | 60% (developer base) | 0% |
| Advance ($7/mo) | 25% | 3% |
| Organization ($10/seat) | 14% | 75% |
| Enterprise (custom) | 1% | 22% |

The 22% Enterprise concentration is plausible only if a sales-led motion
lands 5-10 enterprise logos by year 3, each contributing $100k-$500k
ARR.

### Sensitivity analysis

| Variable | -20% | Baseline | +20% |
| --- | --- | --- | --- |
| New logos / month | $4.3M ARR Yr3 | $7.2M | $10.3M |
| Avg seats / logo | $5.8M | $7.2M | $8.6M |
| Churn rate | $7.7M | $7.2M | $6.6M |
| Conversion free→paid | $6.3M | $7.2M | $8.0M |
| Price elasticity (-$2/seat) | $5.8M | $7.2M | (no upside; pricing is the floor) |

The dominant lever is **new-logo acquisition rate**. Churn and conversion
matter but not as much as keeping new-logo growth above 12% MoM in
years 1-2.

---

## 9. Go-to-market motion

### The funnel

```
1. SEO + content      → blog posts, comparison pages, "Wayve vs Notion"
2. Developer portal   → /developers + tutorials drive integration evals
3. Free tier signup   → personal API + UI access
4. Bring to team      → champion invites colleagues
5. Org-tier upgrade   → admin upgrades workspace
6. Expansion          → more seats + Enterprise SLA upgrade
```

### Channel weighting (year 1 → year 3)

| Channel | Year 1 | Year 2 | Year 3 |
| --- | --- | --- | --- |
| Organic search + content | 40% | 25% | 15% |
| Developer-portal funnel | 25% | 30% | 30% |
| Founder-led outbound | 30% | 15% | 5% |
| SDR-led outbound | 0% | 15% | 25% |
| Partner / referral | 5% | 15% | 25% |

Founder-led outbound caps at ~50 logos / year — past that, the founder
has to step back. SDR-led requires hiring sales (covered in §14).

### Content strategy

**1. Comparison pages.** "Wayve vs Slack," "Wayve vs Google Workspace,"
"Wayve vs Notion." Each ranks for a high-intent query, each ends with
the bundle-pricing argument.

**2. Engineering blog.** Deep technical content (E2E chat design, OpenAPI
philosophy, webhook reliability). Targets engineering decision-makers.
Same content can power the dev portal.

**3. Customer stories.** First 10 should be founder-written even before
they're a polished marketing page. They build trust.

**4. Status page + open metrics.** Uptime page, public p95 latency.
Builds trust with the procurement-conscious ICP.

### Channels NOT to use in v1

- Paid PPC. Brutal CPCs in this category ($15-30 per click).
- Conference booths. $20k for the booth + travel + lost focus.
- Influencer / sponsorship. Hard to attribute, easy to overspend.
- Cold mass email. CAN-SPAM risk; spends brand equity.

---

## 10. Sales process

### Stage gates

```
┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│  Lead          │  │  Discovery     │  │  Trial         │  │  Decision      │
│                │  │                │  │                │  │                │
│ Came in via:   │→│ 30-min intro:  │→│ Sandbox stood  │→│ Procurement     │
│ ─ portal       │  │ ─ pain points  │  │ up; champion   │  │ ─ MSA          │
│ ─ form         │  │ ─ stack today  │  │ pilots 5-10    │  │ ─ DPA          │
│ ─ inbound      │  │ ─ seat count   │  │ users          │  │ ─ AUP          │
└────────────────┘  │ ─ timeline     │  └────────────────┘  │ ─ security Q   │
                    └────────────────┘                       └────────────────┘
       1 day               1 week              2-4 weeks            2-4 weeks
```

### Founder-led sales playbook (first 50 logos)

1. **Take every demo personally.** A founder takes the demos.
2. **One success criterion per pilot.** "Replace Slack" or "stop paying
   Calendly." Not vague "evaluate Wayve."
3. **Pricing on the website.** No "request quote" gymnastics.
4. **A real human responds < 24 h.** This is a sales advantage Big Co
   can't match.
5. **Document the buyer's objections.** Every "we can't because…" is
   either a missing feature (add to roadmap) or a missing trust signal
   (compliance, references) you're building toward.
6. **Annual prepay discount.** 10% off for annual upfront. Bigger discount
   only with executive approval — and the executive is the founder, so
   make it rare.

### Security questionnaire automation

The single biggest time sink in mid-market sales: filling out security
questionnaires. Prepare:

- **Standardized security overview PDF** (encryption, RBAC, audit, SLA).
- **Pre-filled SIG / CAIQ / VSA responses** — keep a master doc, copy
  for each prospect.
- **Vendor portal listing** (eventually: TrustCloud, Whistic, etc.).

Investing time here in year 1 pays back 10x in year 2 sales cycle time.

---

## 11. Product roadmap

### 12-month (priorities ordered)

1. **Search across products.** Universal search bar that hits emails,
   chats, notes, files, tasks. Single biggest "wow" the bundle can
   deliver that competitors structurally can't (their data is split
   across teams).
2. **AI workspace context.** The Gemini bridge today is a chat-only
   assistant; the value unlocks when it can search across the user's
   workspace (with E2E respected for chat).
3. **SOC 2 Type II.** Procurement blocker for 60%+ of mid-market deals.
4. **Mobile apps.** iOS + Android. Required to compete on chat
   reliability and notification.
5. **Calendar polish.** Recurring meetings, time-zone support, calendar
   sharing UX.
6. **Audit log retention + export tiers.** 30/90/365 day retention as a
   pricing axis; export to S3 / Azure Blob.
7. **Wayve as OAuth 2.0 authorization server.** When the first partner
   wants "Sign in with Wayve" — multi-week project.

### 24-36 month

8. **Wiki / docs surface.** Notion-class structured docs. Today's Notes
   is a flat markdown list — fine for personal use, weak for team knowledge.
9. **Workflows / automations.** Zapier-style triggers + actions, native.
10. **Email composer LLM.** "Draft a reply" buttons that respect the
    user's writing style.
11. **Compliance certifications:** HIPAA BAA, ISO 27001, SOC 2 Type II
    refresh.
12. **Self-hosted Enterprise distribution.** Helm chart, Terraform module,
    Ansible playbook for the buyers who want it on their own VPC.
13. **Plugin / marketplace.** Third-party integrations install into the
    workspace.

### What we won't build

- A *replacement* for Gmail. Wayve syncs from Gmail/Outlook — the buyer
  keeps their existing mail relationship.
- A *replacement* for Zoom for large webinars (1,000+ attendees). That's
  a different product category.
- A consumer-grade free app. The free tier is for developers and personal
  power users.

---

## 12. Risk register

Ranked roughly by severity × likelihood.

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| 1 | **Bus factor** (single-founder + AI-pair, no second engineer) | High | Existential | Hire 2nd founding eng by month 9; document everything; bus-factor doc |
| 2 | Google / Microsoft launches a similar bundle at the same price | Medium | High | The encryption + self-host story is structurally different; lean harder into it |
| 3 | SOC 2 Type II not landing by month 12 | Medium | Blocks 60% of ICP deals | Start auditor relationship now (Vanta, Drata); year-1 milestone |
| 4 | Email/chat sync gets unreliable under load (mailbox = 50k messages) | Medium | Customer churn | Already documented bottleneck in technical_wayve.md §16; shard workers when first customer hits it |
| 5 | Pricing pressure from below (Zoho One refresh) | Low-Medium | Margin erosion | Hold the $10 floor; offer annual prepay rather than seat discount |
| 6 | AWS bill surprise (hit-and-run customer pulls 10M API requests) | Low | Operational | Quota system in place; needs alerting on cost spike |
| 7 | Compliance findings (a real auditor finds a real gap) | Medium | Slows enterprise sales | Build compliance program *now* not after first finding |
| 8 | E2E chat protocol flaw | Low | Brand-destroying | Pay for a real cryptographic audit before SOC 2; consider replacing custom RSA wrap with libsignal |
| 9 | OAuth provider revokes Gmail integration | Low | Major feature break | Diversify with IMAP fallback for sync; lobby Google's app-verification queue |
| 10 | Customer data breach via SQLi / handler bug | Low | Catastrophic | sqlx compile-time-checked queries are good; pen-test annually |
| 11 | Adverse press on "yet another productivity tool" | Medium | Slows new logos | Pre-empt with the bundle + encryption + self-host story |
| 12 | Founder burnout | High | Existential | Hire by month 9; no marathons past quarter 2 |

---

## 13. Compliance posture

### What's actually shipped (v1)

- **GDPR.** Right-to-erasure via `DELETE /api/admin/users/{id}` (cascades).
  Right-to-portability via export endpoints. Audit gap: no "data
  processing addendum" template yet.
- **Encryption at rest.** AES-256-GCM via HKDF-SHA512. Documented.
- **Encryption in transit.** TLS via Let's Encrypt. HSTS header.
- **RBAC + audit log.** Documented + exportable.
- **Tenant isolation.** Hard boundaries at the data layer; cross-org
  reads explicitly tested.

### What's missing for SOC 2 Type II

- Continuous security monitoring. (Tooling: Vanta / Drata / Tugboat.)
- Documented incident response plan.
- Documented change-management process beyond `git log`.
- Documented vendor management — what we use, who has access, why.
- Background checks for the team (eventually).
- Documented separation of duties (eventually, with team).
- Quarterly access reviews (manual at v1; tooling later).
- Annual pen-test.
- BC/DR drill annually.

Realistic timeline to Type II:
- Month 1-2: Pick tooling, baseline gap assessment.
- Month 3-6: Type I observation period.
- Month 7-12: Type II observation period.
- Month 13: Audit report.

Cost: $10-30k tooling + $20-40k auditor + ~3 months of founder time
spread across the year.

### Other certs

- **HIPAA BAA.** Requires SOC 2 + a few specific controls (audit log
  retention, encryption KMS-backed). Plausible by month 18.
- **ISO 27001.** Stretch goal for year 2-3.
- **FedRAMP.** Out of scope. Years away. Not part of the ICP roadmap.
- **GDPR DPA.** Trivial template; ship by month 3.

### Data residency

EU customers will ask. Two options:

1. **Self-host on their own EU AWS region.** Already supported — Wayve
   binary doesn't care which region it runs in.
2. **EU-hosted SaaS instance.** Means running a separate Postgres / EC2
   set in eu-central-1. Cost ~+$50/mo. Justified when an EU enterprise
   asks.

---

## 14. Team & org structure

### Today (founder fills in)

- 1 founder (full stack, sales, support).
- 0 - 1 contractor engineers.
- 0 designers.
- 0 sales.

### 12-month target headcount

| Role | Type | When |
| --- | --- | --- |
| Co-founder / 2nd engineer | FT, equity-heavy | Month 3-6 |
| Frontend-focused engineer | FT | Month 6-9 |
| Customer support generalist | PT → FT | Month 6 |
| Designer (product + brand) | Contractor → FT | Month 9 |
| Sales lead / SDR | FT | Month 12+ |

### 24-month target headcount

Same as above + customer success manager (CSM), DevRel, second product
engineer, fractional security/compliance lead.

### Compensation philosophy

- Salaries: at market for the city of hire (San Francisco-comparable for
  remote engineers in mid-cost cities).
- Equity: meaningful (0.5-2% for engineers 2-3, 0.5-1% for engineers 4+).
- No options golden-handcuffs without an obvious vesting cliff.
- Profit-share kicks in when company hits cashflow positive.

### Culture posture

- Async-default. The customer base is global; nobody needs to be in a
  meeting at midnight.
- Document-first. PRs over Slack threads. Wiki / Notes over chat scrollback.
- Customer-touching engineers. Every engineer rotates through customer
  support at least monthly.

---

## 15. Funding strategy

### Three plausible paths

**A. Bootstrap.**
- Cash from first 20-50 paying customers funds growth.
- Slow but full control retained.
- Realistic if founder has 12-18 months personal runway.

**B. Pre-seed / Friends & Family.**
- Raise $150-500k on a SAFE.
- Use it for first hire + 12 months of runway.
- Investors: angels with productivity-tool / SaaS background.

**C. Seed round at the right milestone.**
- Trigger: $50k MRR, ~10% MoM growth, 30+ paying logos.
- Raise: $1.5-3M.
- Dilution: 15-22%.
- Investors: SaaS-focused funds (Bowery, Boldstart, Founder Collective,
  Susa).
- 18-month runway target.

### Recommended path: A → B → C

- Month 1-3: Bootstrap. Get the first 10 logos.
- Month 3-6: Optional pre-seed if hire #2 needs to happen faster.
- Month 12-18: Seed when growth is durable and obvious.

### Investor pitch structure

1. **The trench-coat insight.** Mid-market is paying $50-100/seat for a
   stitched stack; Wayve is $10 unified.
2. **The encryption insight.** Procurement increasingly wants
   self-hostable + E2E options that megacorps don't offer.
3. **The product demo.** Show seven products + the dev portal + a real
   integration in 5 minutes.
4. **The traction.** Logos, MRR, growth rate (if you have them).
5. **The use of funds.** Hires + compliance.
6. **The ask.** Round size + valuation + lead criteria.

Avoid:
- Stock-photo TAM slides.
- "We have no competition." Wayve has 7 competitors per product.
- Promising HIPAA / FedRAMP that's years away.
- Founder-only-can-build framing — investors want to see the team plan.

### Anti-pattern: raising too much too early

A $5M seed at $20M post-money valuation forces growth-stage milestones
(>50% MoM, multi-million ARR by year 2) that put pressure on the team to
optimize for growth-at-all-costs. Better: smaller round, hit milestones,
raise at higher valuation later.

---

## 16. Partnership opportunities

Three categories of partnership worth pursuing:

### 16.1 Distribution

- **MSPs (Managed Service Providers).** They sell Wayve to their SMB
  customers; Wayve pays 20-25% revenue share for 36 months. Best for
  reaching the underserved <50-seat segment.
- **Implementation consultants.** Companies that help SMBs migrate off
  Google Workspace or Microsoft 365. Refer customers in exchange for
  bounty.
- **Privacy-focused VPN / browser brands.** Mullvad, Brave, etc. — cross-
  promote to privacy-conscious audiences.

### 16.2 Technical integration

- **Stripe.** Already integrated for billing. Could go deeper (Stripe
  Connect for customer billing on top of Wayve).
- **Hardware-key vendors (YubiKey, Solo).** Co-marketing on the
  encryption / security story.
- **Privacy-focused ISVs.** Co-sell into shared verticals (healthcare,
  legal, finance).

### 16.3 Strategic

- **A major Linux distribution.** Pre-installed on a privacy-focused
  distro. Cross-promotion.
- **Self-hosting tooling.** Coolify, Caprover, Dokku, etc. — first-class
  Wayve deploy templates.

### Partnerships not to pursue in v1

- Big-tech "marketplace" listings (Salesforce AppExchange etc.).
  Expensive, slow, low conversion at our stage.
- Co-selling deals with mega-vendors. They will eat us.

---

## 17. Customer success + support model

### Stages

| Stage | Headcount | What | Channel |
| --- | --- | --- | --- |
| 0-20 customers | 0 dedicated | Founder does all support | Email + in-app |
| 20-100 | 1 generalist (PT) | Help desk + onboarding | Email + Intercom |
| 100-500 | 1-2 CSMs + 1 onboarding eng | Account health checks + dedicated success | Email + Slack channels + quarterly calls |
| 500+ | 3+ CSMs + named TAMs for Enterprise | Dedicated TAMs for top accounts | Full account management |

### SLA tiers

| Tier | Response time | Resolution time |
| --- | --- | --- |
| Free / Advance | Best effort | Best effort |
| Organization | < 1 business day | 5 business days |
| Enterprise | < 4 hours (business), 24x7 P0 | Per contract |

### Status page commitments

- Public status page (status.rwayve.maheshg.me).
- Auto-posted incidents from the backend health metrics.
- Postmortems within 7 days of any Sev1 incident.

### Self-service docs

- The /docs portal already exists.
- Tutorials on /developers.
- Roadmap published quarterly (founder fills in cadence).

---

## 18. Brand + positioning

### Tagline candidates

- **"One workspace. One bill. No compromises."**
- **"The productivity bundle with encryption defaults."**
- "Five tools, one tool."
- "Privacy isn't a tier."

### Brand voice

- **Honest.** Documents limits, not just features. The "Known limitations"
  sections in our docs are deliberate brand work.
- **Engineering-grade.** OpenAPI spec, runtime docs, the dev portal — all
  signal "we built this for technical buyers."
- **Quiet confidence.** Not "AI-powered cloud-native blockchain SaaS."

### Visual identity

(founder fills in — currently Wayve has a logo + brand color #2563eb;
needs designer attention before brand-conscious customers see it).

### What Wayve is *associated with* — by quarter 4

- "The credible Workspace alternative for mid-market."
- "The tool privacy-conscious teams pick."
- "Honest pricing in productivity software."

---

## 19. Key business metrics (KPIs)

### North-star metrics

1. **MRR growth.** Target: 10-15% MoM in years 1-2.
2. **Net revenue retention.** Target: > 100% (expansion outweighs churn).
3. **Logo growth.** Target: 20+ new logos / month by month 12.
4. **Gross margin.** Target: > 85% (close to industry SaaS median).

### Per-funnel-stage KPIs

| Funnel stage | Metric | Target |
| --- | --- | --- |
| Awareness | Org search traffic | 10k unique / month by month 12 |
| Signup | Free-tier signups | 500 / month by month 12 |
| Activation | Activated users (defined: created ≥ 1 API key OR connected 1 mailbox) | 30% of signups |
| Conversion | Free → Paid | 5-8% of activated users |
| Expansion | Seats added / quarter / customer | +2 seats / quarter |
| Retention | Annual gross retention | > 90% |

### Internal KPIs (operational)

- p95 API latency: < 200 ms
- Uptime: > 99.5% (target 99.9% by year 2)
- Webhook delivery success rate: > 99%
- Email sync staleness: < 60 s p99
- Support response time: < 1 business day

### Anti-metrics (founder should NOT optimize for)

- Total signups (vanity).
- Time-on-app (we want users to *finish* tasks, not linger).
- Number of features shipped (every feature has a maintenance cost).

---

## 20. Investor narrative

### The 30-second pitch

> Mid-market companies pay $50-$100 per seat per month stitching together
> Gmail + Slack + Notion + Drive + Zoom + Calendly. Wayve replaces that
> bundle for $10 per seat per month, with end-to-end chat encryption,
> SCIM, audit export, and a self-hostable binary — the enterprise
> primitives the bundled megacorp suites either don't offer or hide
> behind a $50/seat Enterprise tier. We're at $X ARR growing X% MoM,
> raising $Y to add the second engineer and complete SOC 2 Type II.

### The 5-minute pitch

1. **The problem.** Productivity-tool sprawl is real. (Cite a stat.)
2. **The insight.** Bundle pricing beats stitched pricing, and the
   bundled megacorps (Google/MS) don't offer the enterprise primitives
   mid-market needs.
3. **The product.** Demo 90 seconds of: connect mailbox → see chat +
   email + scheduler in one place → mint an API key → trigger a webhook.
4. **The traction.** Real numbers. No vanity.
5. **The team.** Why this team can build it. Why the next hire is right.
6. **The market.** TAM (defensible — see §3), SOM (year 1-3).
7. **The ask + use of funds.**

### Slides that matter

In priority order (you have 10 slides max):

1. Title (logo, tagline).
2. Problem (3 bullets, no fluff).
3. Solution (one screenshot + 3 differentiators).
4. Market (TAM/SAM/SOM with sources).
5. Traction (MRR, growth chart).
6. Pricing + unit economics.
7. Competition (positioning grid).
8. Roadmap (12-month).
9. Team.
10. Ask.

Skip:
- Mission/vision slide (boring).
- Tech stack slide (engineers care; investors don't).
- "Why now" slide (work it into problem).

### Common investor objections + responses

| Objection | Response |
| --- | --- |
| "How is this not just $TOOL_X?" | "$TOOL_X solves one of seven; we bundle. And we charge less than $TOOL_X alone." |
| "Microsoft / Google will crush you." | "They've had 10 years to ship E2E chat encryption and they haven't. The bundle move is structurally hard for them — they want to upsell enterprise SKUs, not commodify them." |
| "Self-hosting is dead." | "EU procurement says otherwise; Schrems II demands it." |
| "Where's the moat?" | "Bundle data; encryption-default architecture; dev portal as compounding distribution." |
| "Why won't churn be brutal?" | "Bundle = high switching cost. Pulling Wayve = re-stitching 5 tools." |
| "Single founder is risky." | "First hire is funded by this round. Bus-factor mitigation is the #1 line item." |

---

## 21. Exit scenarios

This is a 5-10 year time horizon discussion. Not actionable in year 1,
but useful for investor conversations and equity-planning.

### IPO path

- ARR threshold: $100M+ (median pre-IPO SaaS).
- Year-7 to year-10 if growth holds.
- Requires: scaled operations, audited financials, robust compliance.
- Comparables: Atlassian, Notion (private but IPO-ready), Asana,
  Monday.com.

### Strategic acquisition

Potential acquirers:
- **Atlassian.** Bundles Jira + Confluence; Wayve fills the chat +
  email gaps.
- **Cloudflare.** Edge-of-the-network bundle play. Wayve's TURN already
  uses Cloudflare.
- **HubSpot.** Bundling adjacency. Strong overlap with mid-market ICP.
- **Zendesk / Freshworks.** Productivity bundle that includes support.

Acquisition values for SaaS at ~$10-30M ARR typically land at
**8-15x ARR** in a strategic deal. Less in a financial PE deal.

### Private equity rollup

- ARR threshold: $5-20M ARR.
- PE buys, restructures, exits in 5 years.
- Compatible with founders who want liquidity but not full exit.

### Reverse-merger / SPAC

Don't.

### Founder's decision points

| Year | Decision | Trigger |
| --- | --- | --- |
| Year 3 | "Do I want to keep running this or do I want to exit?" | $5-10M ARR reached |
| Year 5 | "IPO trajectory or strategic sale?" | $30M ARR + strong growth |
| Year 7 | "Convert to PBC (Public Benefit Corp) or scale to IPO?" | Mission durability vs liquidity |

---

## Appendix A — pricing math by customer cohort

| Cohort | Year 1 ACV | Year 1 LTV | CAC | LTV:CAC |
| --- | --- | --- | --- | --- |
| Free → never converts | $0 | $0 | $200 | 0 (charity) |
| Advance → 6-mo churn | $42 | $42 | $50 | 0.84 |
| Advance → 18-mo retain | $126 | $126 | $50 | 2.5 |
| Org (10 seats) → 24-mo retain | $1,200 | $2,400 | $400 | 6.0 |
| Org (50 seats) → 36-mo retain | $6,000 | $18,000 | $800 | 22.5 |
| Org (200 seats) → 36-mo retain | $24,000 | $72,000 | $2,000 | 36.0 |
| Enterprise (custom) | $50,000+ | $250,000+ | $10,000 | 25.0 |

The strategic insight: **larger Org-tier and Enterprise customers carry
the whole portfolio**. Free + Advance are marketing investments, not
revenue.

---

## Appendix B — Glossary

| Term | Meaning |
| --- | --- |
| ACV | Annual Contract Value |
| ARR | Annual Recurring Revenue |
| BAA | Business Associate Agreement (HIPAA) |
| CAC | Customer Acquisition Cost |
| CSM | Customer Success Manager |
| DPA | Data Processing Addendum (GDPR) |
| GTM | Go-To-Market |
| ICP | Ideal Customer Profile |
| LTV | Lifetime Value |
| MoM | Month-over-Month |
| MRR | Monthly Recurring Revenue |
| MSA | Master Service Agreement |
| NRR | Net Revenue Retention |
| PLG | Product-Led Growth |
| PT/FT | Part-time / Full-time |
| SAM | Serviceable Addressable Market |
| SDR | Sales Development Representative |
| SOM | Serviceable Obtainable Market |
| SLA | Service Level Agreement |
| TAM | Total Addressable Market |
| TAM | Technical Account Manager (yes, the same abbreviation) |

---

*Last refreshed: 2026-05-24. Cross-reference: [wayve.md](wayve.md) for
product overview, [technical_wayve.md](technical_wayve.md) for engineering.
This document is a strategic framework, not a forecast — every section
marked "founder fills in" is a decision point the founder must close.*
