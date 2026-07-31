# ByteDance Douyin E-Commerce AI Full-Stack Challenge · Demo and Project Submission Report

"Real-Time Auction Master" — Lumen Auction · Design and implementation of a full-stack live-streaming auction system for Douyin e-commerce

- Team: **Mythos**
- Members: Zhao Ruiqi · Dai Zihan · Liu Zhenyu
- Repository: <https://github.com/Eliaaazzz/live-auction-system>
- Internal freeze: 2026-06-09 | Public demo: 2026-06-11 – 12

> **This file and `Lumen-Auction-Submission-Report.docx` are the same material from one source**: the markdown source is for paragraph-level review on GitHub, and the docx is for the formal submission. The two must stay in sync — any revision to one should be written back into the other.

---

## Introduction and reading guide

This report is the deliverable write-up submitted by team Mythos for the "Real-Time Auction Master" track of the ByteDance Douyin E-Commerce AI Full-Stack Challenge. The system we deliver is codenamed Lumen Auction, after the lumen — a physical unit of light that can be measured precisely — to express this team's engineering commitment that auction data must be "consistent, adjudicable, and replayable": why each bid took effect, who won at what price and when, and whether any record has been altered should all be explainable to judges and regulators line by line.

To make the report easy to navigate, its section order follows exactly the fourteen items required by the competition's "Demo Deliverable" template, plus three extra sections — "Scoring alignment overview", "Key milestones and honest-boundary statement", and "A five-minute check for judges" — so that judges can cross-check within limited time. Given that "implementation and engineering completeness" carries 50% of the weight and "technical depth and innovation" 25%, this report concentrates on chapters 10, 12, 13, and 14; and to earn the 10% for "project material completeness", the whole document uses a consistent convention for figures and code, with every key conclusion carrying an evidence pointer that can be re-checked inside the repository.

One point worth stating up front: wherever this report makes a claim about performance numbers, concurrency scale, or system boundaries, it gives the test topology and measurement basis in line with the "bounded claim" principle — neither dodging the conclusions we did meet nor hiding the capacity ceilings we already know about. We believe that honesty is itself part of what the "system availability and data consistency" dimension is meant to assess.

---

## 1. Project title

"Real-Time Auction Master" — Lumen Auction · Design and implementation of a full-stack live-streaming auction system for Douyin e-commerce.

This work addresses the "Real-Time Auction Master" challenge for a full-stack Douyin e-commerce live auction system, internally codenamed Lumen Auction. The system targets high-value goods that are hard to price uniformly — jewellery, art, second-hand luxury — and completes the full loop of "list the item → configure rules → bid in real time → dynamic ranking → close the sale" in a live-auction format, on top of which it builds an audit capability that can prove its own correctness to a third party.

---

## 2. Team name and members

The team is named Mythos, and all three members are from the University of Melbourne, each with commits across every milestone. The table below lists each member's school, major, GitHub account, and area of primary responsibility, per the official template.

| Member | School | Major | GitHub | Primary area |
|---|---|---|---|---|
| Liu Zhenyu | University of Melbourne | Computer Science | @Eliaaazzz | Backend and engineering lead (core services / gateway / deployment) |
| Dai Zihan | University of Melbourne | Computer Science | @PDGGK | Product / testing / compliance (adversarial testing / ALL_PAY compliance boundary) |
| Zhao Ruiqi | University of Melbourne | Data Science | @fariZzzz | Full-stack collaboration / process governance / review and release |

*Table 2-1  Mythos team roster (school / major / account / primary role)*

---

## 3. Division of work

The team works trunk-driven, splitting a two-week development window into eleven milestones, T0 through T10. The three members did not mechanically slice the work into "frontend / backend"; instead they collaborated around a discipline of "contracts first, everyone reviews": every cross-module protocol (the WebSocket envelope, the Redis key space, the database schema, error codes, the evidence card, AI events) is written down as a proto contract file, and any change must be ratified by all three before it can merge. With that arrangement, a small team still kept code quality and consistency under control. The table below gives the concrete split by primary responsibility.

| Module | Lead | Collaborators |
|---|---|---|
| Backend core: Go + Redis Lua + MySQL, including the state machine, bid engine, timed hammer, persistence, and replay verification | Liu Zhenyu | Zhao Ruiqi reviews / Dai Zihan tests |
| WebSocket gateway: room isolation, heartbeat keepalive, reconnect catchup, coalesced broadcast for large rooms | Liu Zhenyu | Zhao Ruiqi reviews |
| AI sidecar: Doubao vision fact extraction and auctioneer text generation, deployed as its own process | Liu Zhenyu | Dai Zihan does compliance review |
| Seven auction modes: dispatched by one unified strategy registry | Liu Zhenyu | Zhao Ruiqi reviews contracts / Dai Zihan writes adversarial tests |
| Frontend: React + TypeScript + Vite, the mobile live room and the PC admin console | Liu Zhenyu | Zhao Ruiqi does UX review and defect fixes |
| Production deployment and continuous delivery: Volcengine ECS, automated deploys, deploy-identity gating | Liu Zhenyu | Dai Zihan reviews the runbooks |
| Testing and load testing: 10k-scale concurrency, chaos drills | Liu Zhenyu | Dai Zihan writes adversarial cases / Zhao Ruiqi does regression verification |
| Process governance and review standards: contracts first, all-member approval | Zhao Ruiqi | Jointly approved by Dai Zihan and Liu Zhenyu |
| Demo materials and scoring alignment | Zhao Ruiqi + Dai Zihan | Everyone |

*Table 3-1  Responsibility matrix by primary owner*

---

## 4. Core feature list

We group the system's capabilities into five feature clusters along the user's path. The first two face real users (merchants and buyers) and form the core loop the challenge requires; the last three are engineering and demo capabilities, and are what set this work apart from an ordinary auction demo.

### 4.1  Merchant / host side (PC admin console)

A merchant performs every operational action, from listing to sale, in the admin console. Listing supports a title, image URLs, and a description, and an AI vision model drafts a set of product facts that the merchant must confirm item by item before proceeding. Rule configuration covers the start price, bid increment, cap price, auction duration, anti-snipe extension window, and maximum number of extensions, plus a choice of one of seven auction modes. The live console expresses an auction's lifecycle clearly as the state flow "draft → freeze rules → start → live bidding → one-click cancel → hammer → order". After a sale the system creates the order automatically; the merchant can look up the sale details in order management and download the hash-chained evidence file for audit.

### 4.2  Buyer side (mobile H5)

The buyer side is the main stage for competitive atmosphere. In production the room plays a Volcengine Live HLS stream and degrades to a locally simulated feed when the network is unavailable, while a room-level WebSocket connection keeps it in millisecond-level sync with the server. Bidding uses a dual-channel design of "HTTP first, WebSocket as fallback", with both channels sharing the same deduplication identifier, so a millisecond-level bid confirmation only needs one of the two channels to be available.

On the atmosphere layer, the system implements instant flash feedback for taking or losing the lead (matching the challenge's bonus items "🎉 In the lead!" and "⚡ Outbid!" emotional feedback), a rolling price animation, leaderboard avatar flight animation (matching "real-time leaderboard"), a red pulsing ring and heartbeat sound in the last ten seconds (building the tension called for by "countdown animation and bid sound effects"), a light sweep on anti-snipe extension, and a glory-moment effect after the hammer. We care especially about making "the rules visible": when anti-snipe fires, the interface shows an explicit banner reading "Anti-snipe triggered · +30s · 3rd time" rather than letting the countdown quietly grow; when a user is outbid, the call-to-action button offers a concrete action such as "Bid 5,000 more to retake the lead"; and long-pressing the bid button opens an increment wheel that goes through the same bid channel as a tap. After a disconnect the system reconnects automatically and replays missed events anchored on the last received sequence number, keeping the user's view continuous.

**Voice bidding (confirmation-based)**: the buyer side integrates a voice bidding channel built on the browser's SpeechRecognition API (`apps/web/src/components/VoiceBidButton.jsx`, `apps/web/src/lib/voicebid.js`). A buyer can speak a phrase such as "raise five thousand", "bid one hundred and thirty-eight thousand", or "up one step" directly at the phone; the frontend parses it into a target amount in string cent units and shows a one-line confirmation, and **only after the buyer explicitly taps confirm** does it go through exactly the same bid channel as the increment wheel (sharing the same client bid identifier and the same HTTP-first + WebSocket-fallback path). Browsers without the speech API, and recognition errors, degrade to a visible hint without blocking ordinary bidding; if the current price or increment changes before confirmation, the pending voice amount is cleared proactively so the buyer cannot submit a stale parse. This design extends AI to the buyer side while strictly avoiding the compliance risk of "AI deciding the amount for the user", via explicit confirmation.

### 4.3  AI sidecar (Doubao-Seed-2.0-lite)

AI is integrated strictly as a sidecar. The vision model extracts structured fact drafts — brand, model, condition, flaws — from the product photos; these drafts are never written to the database automatically and must be confirmed item by item by the merchant before the auction can go ahead. The language model generates auctioneer lines at four trigger points — open, price surge, silence, and hammer — streamed out character by character. When the AI sidecar is offline it degrades to a status badge and never blocks the bid path.

### 4.4  Seven auction modes

All five rules the challenge requires (start from zero, bid increment, cap price, automatic extension, abnormal cancellation) are implemented; on top of that we introduced six additional pricing and competition mechanisms, all dispatched by one unified strategy registry. The seven modes are: English (the public ascending baseline), sudden death (hammer on the first bid past the point), first-price sealed bid, second-price sealed bid (Vickrey), hybrid reveal (hide the leader, show the runner-up), all-pay (a demonstrative virtual-coin forfeit), and two-stage prequalify (a sealed warm-up followed by the formal open auction). Each mode has its own Lua script and a strictly asserted demo, and all of them are in the continuous-integration regression net; the all-pay mode is bounded strictly for compliance by a "virtual coins · not a real payment · not gambling" marker. The economic archetype and key technical implementation of each mode are in chapter 13, highlight one.

### 4.5  Engineering gates and observability

The system embeds a replay verifier that compares the Redis event stream, the Redis state snapshot, and the MySQL projection sequence number by sequence number, emitting one of three machine-readable conclusions: "consistent", "mismatch at sequence N", or "hash break at sequence N". Every auction event participates in an HMAC SHA-256 hash chain, so any tampered row is exposed immediately at verification time. The system also exposes a metrics endpoint and a version endpoint: the former is for observing bid-ack latency, broadcast latency, sequence gaps, and the number of live connections; the latter returns four fields — protocol version (`schemaVersion=2`), build commit (`buildSha`), build time (`buildTime`), and runtime environment (`appEnv`) — and the continuous-delivery pipeline hard-checks three conditions after deployment (protocol version equals 2, build commit equals the expected commit, build time is not "unknown"); any drift is treated immediately as a deployment that did not take effect. This mechanically guarantees that "the live system you see in the demo is exactly the binary that passed continuous integration". On the alerting side, key signals such as backpressure force-closes, sequence gaps, AI offline duration, and replay-verification failures are all exposed through the metrics endpoint and can be scraped by an external Prometheus and Alertmanager with threshold-based rules; during the demo we substitute manual inspection of the metrics endpoint for a wired-up alerting path, and list wiring up alerting as post-deployment work.

---

## 5. End-to-end user flow

A complete auction, from the merchant logging in to the post-demo replay, runs through the following eight steps.

1. **Login**: the merchant opens the admin console and obtains a seller identity through the login endpoint (dev-mode passwordless login is disabled in production); a buyer simply lands on the home page and browses the public auction list.
2. **Publish**: on the "New listing" page the merchant fills in a title, image URLs, and a description; the vision model automatically drafts several facts; the merchant confirms each one and then configures the rules (including the mode choice), and on submit gets an auction in the draft state.
3. **Start**: the merchant first "freezes the rules", moving the auction to scheduled, then clicks "start" to make it live, and the state machine enters the real-time phase.
4. **Watch and bid**: once a buyer enters the room the WebSocket connects automatically and pulls the first-paint snapshot; tapping an increment button (or speaking "raise five thousand" at the phone and confirming) reaches the backend via the HTTP command channel (or the WebSocket fallback), is adjudicated atomically by a Redis Lua script, and is then acknowledged directly on the same connection and broadcast to the room.
5. **Atmosphere and anti-snipe**: the current price rolls over, the leaderboard flies, a golden flash and heartbeat sound mark taking the lead, a red drop bar and a retake-the-lead call to action mark being outbid, and a red pulsing ring marks the last ten seconds; a bid inside the anti-snipe window triggers an extension event and a light sweep.
6. **Hammer**: the timer worker detects that the end time has passed, calls the close script for atomic adjudication, and publishes one of three terminal states — sold / no bid / cancelled — after which the frontend plays the hammer sound and the result screen.
7. **Payment and evidence**: after a sale the persistence worker creates the order idempotently under the per-auction unique constraint, and the buyer completes a simulated payment; tapping "view evidence" shows the chain formed by each event's sequence number, type, and previous/current hashes.
8. **Post-demo replay**: at any time the operator can run replay verification and evidence verification on that auction, confirming that all three data sources agree and the hash chain has not been tampered with.

---

## 6. Live demo links

The system is deployed on a Volcengine Beijing ECS instance, and the continuous-delivery pipeline deploys automatically once continuous integration passes on the main branch. The table below gives the publicly reachable entry points.

| Entry point | Link | Notes |
|---|---|---|
| Production public entry | <http://115.191.76.40> | Auto-deploys main; the version endpoint returns the build identity |
| Health check | <http://115.191.76.40/healthz> | Liveness at any time |
| Deploy identity | <http://115.191.76.40/version> | Confirms the live system is the binary that passed continuous integration |
| Merchant console | <http://115.191.76.40/admin> | Requires a seller login |
| Judges' director mode | <http://115.191.76.40/showcase> | Six buttons walk the whole auction loop; recommended as the primary entry on demo day if deployed, otherwise use the home page plus room combination (always available locally) |

*Table 6-1  Live demo entry points*

**Note on entry-point availability**: the judges' director mode at `/showcase` is a one-click demo entry we prepared for review; its public deployment depends on main being frozen and continuous delivery completing on demo day. If it is not deployed in time, please use the "production public home page + live room" combination instead, or start the stack locally with one container-orchestration command and open `http://localhost:8080/showcase` for the same experience.

**Note on trial accounts**: production disables dev-mode passwordless login; a buyer can submit a nickname to the login endpoint and receive a buyer token instantly. Seller accounts are provided verbally by the team on demo day, and judges can also obtain a seller identity directly via dev-mode passwordless login after starting the stack locally with one command. The minimal local reproduction commands are in chapter 9.

---

## 7. Demo video link

The demo video runs about three minutes and will be uploaded once the demo-day build is frozen; the link is: **[public video link to be added after the demo build is frozen]**. The video script follows the demo narration script in the repository, with these key beats: the first twenty seconds align the audience on the challenge; about forty seconds then walk the full English-auction loop (publish, bid, anti-snipe extension, hammer, order, evidence card); around one minute quick-cuts through the innovative modes (sealed bids hidden, hybrid mode hiding the leader, all-pay virtual-coin forfeit, two-stage prequalify pricing); about forty seconds after that show the high-concurrency core (a 10k-scale WebSocket live run plus the server-side latency dashboard); and the final thirty seconds present AI in practice (live footage of vision fact extraction, the auctioneer's four triggers, voice-bid confirmation, and AI-offline degradation). To guard against network trouble on the day, we also prepared a network-independent local fallback recording and locked the day's operating steps into the rehearsal checklist.

---

## 8. Source repository link

The main repository is <https://github.com/Eliaaazzz/live-auction-system>, and the stable demo branch is `main`. Over the two-week development window we accumulated more than one hundred and eighty merged pull requests (185 as of the freeze), all through the "contracts first, all-member approval" review process, with core code changes needing at least two approvals and cross-module contract changes needing all three.

Continuous integration consists of four gates (backend, frontend, end-to-end, and convention guards); once they pass, the continuous-delivery pipeline deploys automatically to ECS, after which the build identity from the version endpoint is hard-checked against the expected value, and a failed check is treated as a deployment that did not take effect. This mechanism ensures that "the live system the judges see is exactly the binary that passed continuous integration".

- **main HEAD at submission** (replace with the freeze commit before the demo): `[freeze SHA]`
- **The corresponding continuous-integration run**: `https://github.com/Eliaaazzz/live-auction-system/actions/runs/<id>`

---

## 9. README and run instructions

The README at the repository root runs to roughly five thousand words across nearly twenty sections, covering the project introduction, dependencies, startup steps, directory structure, and configuration. Minimal local reproduction needs only Docker and Docker Compose:

```bash
# Dependencies: Docker + Docker Compose (v2)
git clone https://github.com/Eliaaazzz/live-auction-system.git
cd live-auction-system

# One-command start (about 1 minute; creates tables and loads seed data automatically)
make up      # starts four containers: mysql / redis / ai-sidecar / lumen
make seed    # creates one live auction, auc_demo

# Browse
open http://localhost:8080/             # home page
open http://localhost:8080/admin        # merchant console (dev-mode passwordless login enabled)
open http://localhost:8080/room/auc_demo  # live room

# One-command full demo (seven modes + chaos drills + load smoke)
make demo-smoke
```

The project uses a clear layered directory structure, with applications, infrastructure, contracts, documentation, scripts, and tools each in their own place, which keeps it maintainable and extensible.

```
live-auction-system/
├── apps/
│   ├── lumen/        # Go backend (server / store / model / lua / metrics / auth)
│   ├── ai-sidecar/   # Doubao-calling process (deployed separately, HTTP interface)
│   └── web/          # React + TS + Vite frontend (admin + mobile + showcase)
├── infra/            # docker-compose local stack / production stack + Caddy / DDL
├── proto/            # contracts: ws envelope / redis keys / db schema / error codes / evidence card / ai events
├── docs/             # 25+ design documents (architecture / reviews / runbooks / perf reports / decisions)
├── scripts/          # deployment / demo / evidence collection / 10k re-test wrapper scripts
├── tools/            # load testing (k6 / wsload / Locust) + the chaos runner
└── Makefile          # dozens of demo / test / load / chaos entry points
```

**Configuration**: the development environment needs zero configuration and the container orchestration ships default secrets; production requires explicit values for the JWT secret, evidence hash key, Doubao API key, and build identity, and the config loader hard-refuses defaults in production mode. For security reasons this report does not print any real secret anywhere.

---

## 10. System architecture diagram

The system follows a four-layer "client — edge — core — data" architecture, with AI integrated as an external sidecar. The client layer covers the PC admin console, the mobile live room, and load-testing bots; the edge layer has Caddy terminating TLS and handling the WebSocket upgrade, then splitting traffic between a REST backend that handles auth and command routing and a WebSocket gateway that handles room isolation and broadcast; the core layer brings together the auction service, bid engine, timed hammer, order service, persistence worker, and replay verifier, with every write going through Redis Lua scripts as the sole entry point; the data layer uses Redis 7 as the real-time hot source and MySQL 8 as the durable fact store.

*Figure 10-1  Lumen Auction architecture overview (four layers + external services; see the figure in the docx)*

The critical call chain for one bid can be summarized as: the browser sends an HTTP-first request to the bid endpoint; the server hands it to a Redis Lua script for atomic adjudication — inside a single thread the script consecutively performs state validation, amount and cap validation, the anti-snipe extension decision, the sequence increment, the event append, and the room publish — and the server then returns the bid ack directly on the same connection; broadcast happens when a subscriber goroutine consumes the publish channel and fans out to every connection in the room, using coalesced broadcast in 10k-scale rooms to cut write amplification. On the external-service side, the AI sidecar process calls the Doubao model over one-way HTTP; the core never waits for an AI result and degrades on timeout.

### 10.1  Data collection and governance

Against the challenge's requirement for a complete chain "from auction data collection through data governance to backend services", this system's data path can be re-checked segment by segment. On collection, every bid command enters the server through the REST command channel or the WebSocket entry point, and user behaviour such as connects, disconnects, reconnects, and bid frequency is aggregated into observable series through the metrics endpoint. On governance, every auction event is recorded in full in the Redis Stream as the authoritative ledger, each event carrying five fields — sequence number, event type, payload, previous hash, and current hash — and projected into MySQL by the persistence worker for long-term storage, forming a two-tier "real-time ledger + long-term fact store" retention model. On the AI side, the system maintains an `ai_usage_logs` table in MySQL that archives every meaningful call with fields for scenario, model, input summary, output summary, whether it was human-reviewed, and the final decision (accepted / modified / rejected), forming the data-governance basis for "AI behaviour is traceable". So from bid and behaviour collection, through event-ledger and projection retention, to the archiving of AI calls, the whole data chain can be re-checked item by item.

### 10.2  Technology choices and fit

On technology selection, every decision this team made serves three goals: real-time, atomic, adjudicable. We chose Go over Node.js for the backend because the goroutine model is a natural fit for a gateway where "each WebSocket connection is one lightweight concurrency unit", and a single process can make the fanout tail latency at 10k connections predictable; Go's single static binary also lowers the deployment barrier and makes builds reproducible, which reinforces the goal of "demoing the exact binary that was verified". We chose Redis single-threading plus a single Lua script over a distributed lock for bid adjudication because a distributed lock needs leases, renewals, and clock assumptions — high complexity and sensitivity to clock drift — whereas Redis's serial single-threaded execution lets us package "read state, validate, write state, publish" into one atomic operation, optimizing complexity and correctness at the same time. We also deliberately avoided higher-level abstraction libraries such as Socket.io: those libraries tend to hide critical boundaries like protocol versioning and backpressure control inside the framework, whereas this system specifically needs those boundaries to be visible in contract files, testable in continuous integration, and demonstrable to judges; native WebSocket plus our own protocol layer (protocol version, last-sequence catchup, typed close codes) is the more controllable choice.

For the frontend we chose React and TypeScript: the mature component-testing ecosystem serves both atmospheric animation and unit coverage, while TypeScript provides compile-time protection on cross-module contracts such as the WebSocket envelope, the state machine, and money-as-string, forming a "compile-time plus runtime" double consistency guarantee together with the proto contract files. In the data layer, Redis 7 is the real-time hot source and event ledger while MySQL 8 is the long-term fact store and projection; separating those responsibilities avoids the common trap of "using one store for both real-time transactions and long-term analysis". And the Redis Stream's "sequence-0" style identifier maps directly onto the "auction id plus sequence" unique constraint in MySQL, so the two layers align structurally by construction.

---

## 11. LLM / AI capability notes

### 11.1  Model and service

The system uses ByteDance Volcengine Ark's Doubao-Seed-2.0-lite integrated multimodal model throughout: its vision capability extracts product facts from photos and its language capability generates auctioneer lines. Per the resource-usage requirement that "all members of one project share an account, do not leak it, and use it only for this project", the model endpoints and keys are injected only as environment variables into the runtime and appear neither in the repository nor in this report.

On the optional item "open-source model integration": this system positions AI calls as a "non-adjudicating, degradable-in-milliseconds" sidecar, so we deliberately kept model hosting and scheduling complexity to a minimum. The Doubao integrated multimodal service covers both vision and language needs from one endpoint and satisfies all three conditions — a resource recommended by the competition, an integrated call path, and degradable on failure — so after evaluation the team saw no need to bring in an open-source model and stand up local inference. That choice itself expresses the engineering trade-off that "AI is only a sidecar, never authoritative".

### 11.2  Where AI sits in the system, and its boundary

The AI sidecar is a fully independent process (its own container, its own deployment) that communicates with the core services only through one-way HTTP calls. We established "AI never participates in adjudication" as a hard system invariant.

AI-call timeouts are in fact a **layered defence**, each layer with a hard ceiling so the core never waits:

- **Gateway → sidecar (lumen→sidecar)**: a 5-second hard client-side timeout per HTTP call (`apps/lumen/internal/server/auctioneer.go`), matching the contract declared in `proto/ai-events.md`. That is the maximum patience the bid/state/order path has for the AI sidecar.
- **Sidecar → Doubao model**: 30 seconds by default, overridable through an environment variable such as `LLM_TIMEOUT_MS`; it was raised from 8 seconds in issue #253 to accommodate real model paths where upstream inference can be slow (`apps/ai-sidecar/internal/llm/openai.go`).
- **Image fetch**: a 5-second hard timeout on the sidecar side (`apps/ai-sidecar/internal/ssrf/allowlist.go`), also bounded by the SSRF allowlist.

A timeout at any layer triggers degradation immediately: a failed HTTP call means the sidecar returns fallback copy or the UI shows a badge; a 5-second gateway-side timeout means a UI badge; and the bid, state-machine, and order paths are **entirely unaffected**. The operational goal is to keep the median time-to-first-token within a few hundred milliseconds, which depends on Doubao's actual server-side response rather than on a configured threshold. This layered boundary guarantees that no matter whether the model is available or how fast it responds, the correctness and real-time behaviour of the auction never waver.

### 11.3  The auctioneer text stream's four triggers

The language model generates lines at four semantic trigger points (the code constants `open`, `surge`, `cold`, `hammer`), and each line passes the sidecar's post-filter guardrail (banned words, advertising promises, personal information) before being sent to the room.

| Trigger | When | Intent of the line | UI colour |
|---|---|---|---|
| Open | The auction has just gone live | Introduce the item, start price, and rules | Blue |
| Surge | A bid far above the minimum increment arrives | An exclamation that encourages competing bids | Orange |
| Cold | Thirty seconds with no new bid | A cooling line reminding people of the countdown | Grey |
| Hammer | The moment of sale | Call out the hammer price and congratulate the winner | Gold |

*Table 11-1  The auctioneer text stream's four triggers*

### 11.4  The product boundary of vision fact extraction

After the merchant uploads product photos, the vision model follows the prompt to extract several structured facts (brand, model, condition, key specifications, flaws, and so on; the prompt template targets five to eight, with the actual count depending on the model's output). Those facts are not written into the database automatically — the merchant must confirm, edit, or delete each one in the console, and only when all are confirmed can the auction move from scheduled to live. That is how we draw the product boundary for AI: AI is there for efficiency, not to take over the seller's responsibility for the truthfulness of the product description.

### 11.5  AI-offline degradation (a hard invariant)

"When AI is offline, the auction core is one hundred percent unaffected" is a hard constraint written into the continuous-integration gates. It is verified by stopping the AI sidecar container in CI and re-running the end-to-end bid case (which must pass), then restarting the sidecar and running it again (which must pass); either failure blocks the merge. In the UI it appears as an "auctioneer has stepped away" badge at the top of the AI bubble, while bidding, the countdown, and the leaderboard remain entirely unblocked.

### 11.6  Use of AI coding tools and code contribution rate

During engineering the team mainly used two AI coding tools, Claude Code and Codex. We picked those two because they fit this project's workflow: Claude Code is strong at repository-level, multi-file context reasoning and can carry out cross-module changes against the interface specifications we wrote down as contract files, matching our "contracts first" discipline; Codex is notably efficient at generating scaffolding, test fixtures, and repetitive boilerplate, which suits drafting at the UI and test layers. Both run as command-line, agentic workflows, so they slot naturally into a process of "pull-request review plus four continuous-integration gates", meaning anything AI drafts must pass human review before merging. To be clear, this report does not claim these two tools are the competition's only recommended or optimal choice; it only states the trade-off this team made for its own workflow. We also did not use single-file completion tools such as GitHub Copilot, because this work values "cross-module contract consistency" over "single-line completion speed", which suits agentic coding tools with whole-repository awareness. We record meaningful AI drafting decisions one by one in the repository using a log template, so the process stays disciplined and traceable.

On contribution rate, our self-assessment is: for core business code (bid adjudication, the state machine, Lua scripts, replay verification), roughly 30–40% was AI-drafted under human direction and strict review; for UI and scaffolding code, roughly 60–70%; for tests and documentation, roughly 50%. A note on how those numbers were estimated: they are rough cross-estimates from line-level `git blame` statistics and the "AI-drafted, human-modified / rejected" labels in review records, and they count "AI drafts, humans control" (human compliance edits plus explicit approval) rather than treating line-count inflation itself as a metric.

We agree with the judgement that "a higher AI code contribution rate is not inherently better; what matters is human control at the key decision points", and we organized our whole engineering discipline around it. Concretely, key decision points are one hundred percent human-designed and AI only helps fill in detail code. For example: the atomic boundary of the bid Lua script — the six-step order of read state, validate, dedupe, compute the new sequence, write state, and publish, along with its failure semantics — was human-designed, with AI only helping generate the detail of the boundary checks; the key threat-model boundary of the HMAC hash chain — the security position that "when the verifier and the writer share a process, this degrades to an internal consistency guarantee" — was assessed entirely by humans and written into the security baseline document; the dispatch architecture for the seven auction modes — one strategy registry as the single funnel, with each mode implementing only its differentiated adjudication — was decided by humans through design review, with AI generating each mode's Lua skeleton before humans checked every invariant by hand. All AI-drafted code must pass pull-request review and four continuous-integration gates before merging. In addition, the system maintains the `ai_usage_logs` table in MySQL, archiving every meaningful AI call by scenario, model, input summary, output summary, human-review status, and decision (accepted / modified / rejected), which together with the "contracts first, all-member approval" discipline forms an auditable basis for AI use.

---

## 12. Key engineering challenges and solutions

The engineering difficulty of an auction system concentrates on two threads: "correctness under high concurrency" and "consistency under real-time constraints". This chapter picks the five most representative challenges and works through the nature of each problem, the solution, and the verification result. Together those five cover nearly every assessment point in the scoring criteria — "bid validation and state-machine control", "system availability and failure fallback", "performance, stability, and data consistency", and "observability".

### 12.1  Challenge one: atomicity and double-spend prevention under concurrent bidding

When hundreds of users hammer the bid button in the final second, the system must simultaneously guarantee four things: the same bid (keyed on the client bid identifier) cannot produce two ledger entries; event sequence numbers increase strictly monotonically with no gaps; the checks for seller self-bidding, the cap price, and the anti-snipe window complete atomically; and any failure returns an unambiguous error code the frontend can turn directly into interaction feedback. A race in any one of those could produce unacceptable outcomes such as "one bid charged twice" or "the ranking scrambled".

Our solution makes the Redis Lua script the sole write entry point. Every bid path in the Go layer calls Lua only, so there is no way to bypass the script and write state directly. Because Redis runs single-threaded and an entire Lua script is serial by nature, we get atomicity without introducing distributed locks or transactions. The script logic can be summarized in the six steps below.

```text
-- place_bid.lua (logic in brief)
1. Read the state Hash (status / current / seq / sellerId / endAtMs)
2. Validate: is live, not the seller's own bid, amount >= current + increment, under the cap, not expired
3. Dedupe: a hit on a previously cached clientBidId replays the original ack (idempotent)
4. Compute the new price and new sequence, plus any extension per the anti-snipe rule
5. Write the state Hash + write the leaderboard ZSET + append to the event Stream + publish to the room channel
6. Return the JSON-encoded bid-ack payload
```

That design brings several key properties: the whole adjudication executes atomically without locks; the event stream's identifier is designed as "sequence-0", so the sequence number and the stream offset map strictly one to one and later reconnect catchup can slice a range query straight to the client without extra sorting; and multi-key operations are pinned to the same slot by a hash tag, leaving room to move to Redis Cluster later. In 10k-scale load tests, bid-ack latency at the 95th percentile is sub-millisecond, sequence gaps are zero, backpressure force-closes are zero, replay verification returns consistent, and the hash-chain check passes. The specific numbers are in chapter 14.

### 12.2  Challenge two: the state machine's seven canonical states and eight invariants

An auction's lifecycle is naturally complex — from draft, scheduled, and live, branching into sold, no bid, and cancelled, and then on to order created — and the transition conditions, visibility, and frontend rendering must line up exactly. A common trap is mistaking "automatic extension" for a state of its own: it is in fact only an event and the state does not change. Handled badly, the frontend ends up rendering states and events interchangeably.

Our approach converges the lifecycle explicitly on seven canonical states, written into the state-machine contract: draft, scheduled, live, sold, no bid, cancelled, and order created. "Automatic extension" is forcibly defined as an event, not a state, and the frontend renders it as an extension-count badge plus a light-sweep animation. All state transitions are enforced at a single point in Lua: start, bid, hammer, and cancel each have their own script for one segment of the transition, and the Go layer never bypasses them. On top of that we wrote eight invariants into the review standard, as a checklist for every code review.

| # | Invariant | Enforcement point |
|---|---|---|
| P1 | Money always crosses boundaries as a decimal string, never as a float | Fixed-point cents on the backend + big integers on the frontend |
| P2 | The seven canonical states map strictly one to one onto the UI | A single state-badge mapping table on the frontend |
| P3 | AI never participates in adjudication | The AI-offline end-to-end gate |
| P4 | The countdown follows the server clock | The client maintains a clock offset |
| P5 | The extension count must be visible in the UI | A hard constraint on the extension badge |
| P6 | The evidence chain's HMAC SHA-256 is intact | The evidence-verification exit code |
| P7 | A disconnect catches up from the last sequence number | The catchup protocol + fast-forward animation |
| P8 | WebSocket handling must not block broadcast | Continuous perf-smoke monitoring |

*Table 12-1  The eight engineering invariants (review standard)*

### 12.3  Challenge three: WebSocket instability and broadcast pressure in 10k-scale rooms

Two kinds of pressure meet here. The first is connection instability: network jitter, NAT timeouts, and a phone's screen going dark all break a long-lived connection, and the system must recover without losing events. The second is broadcast write amplification: with thousands of users in one room, a single bid ack has to fan out to everyone, and a naive implementation makes broadcast writes the bottleneck. The challenge's bonus item gives a baseline of one thousand concurrent users in one room; we raised our target to ten thousand, ten times that baseline.

For connection recovery, each client carries the last sequence number it received when it rejoins the room, and the server fills in the missing events with a range query, or sends a full snapshot outright when the gap is too large. For broadcast write amplification, we designed coalesced broadcast for large rooms: once the viewer count exceeds a threshold, consecutive bid acks are merged into a single state-patch frame refreshed at a fixed rate; meanwhile the bidder still receives a millisecond-level ack directly on their own connection, and the remaining viewers fall back to the coalesced patch. That takes the broadcast write-amplification factor from "bids per second × room size" — which grows linearly with bid bursts and is uncontrollable — down to "patch refresh rate × room size", which is capped by a server-configured refresh limit, keeping broadcast latency at the 99th percentile within a few hundred milliseconds even in a 10k-person room.

On backpressure governance, we split downstream frames into two lanes, critical and best-effort: if a critical frame (bid ack, terminal event, snapshot, catchup) overflows its buffer, the connection is force-closed with a typed close code and the client bounces, reconnects, and catches up; if a best-effort frame (heartbeats and similar re-sendable content) overflows, only that frame is dropped and the connection is kept. We further split ack and broadcast into sub-channels, so a bidder's own ack can never be blocked behind room broadcast. Heartbeat keepalive prevents OS-level long blocking reads, and a protocol-version gate lets the client distinguish "protocol mismatch" from "network failure" as two different degradation paths.

### 12.4  Challenge four: adjudicable, replayable, audit-grade correctness

An auction is a money business, so "consistent in real time" is not enough: it must also be replayable after the fact, able to detect tampering, and able to explain to a customer or a regulator "why this person won". For that we built an audit capability of "three-way consistent replay verification + an HMAC SHA-256 hash chain". The three data sources are the Redis event stream as the authoritative ledger, the Redis state snapshot for convenient querying, and the durable, backup-friendly MySQL projection. The replay verifier replays every event from the start of the stream, compares the three sources at the sequence-number level, and emits a machine-readable conclusion. The hash chain computes each event as follows.

```text
event_hash = lowerhex( HMAC_SHA256( KEY,  prev_hash || seq || event_type || payload_json ) )
```

Tampering with any single row breaks every hash after it, and evidence verification reports the breaking sequence number immediately. The client's evidence card shows each event's sequence number, type, and previous/current hash prefixes clearly, expandable to the full chain. We also state the threat-model boundary of this design publicly: because the hash key lives in the same process as the writer, an internal attacker could in theory re-chain a forgery, so this is an "internal consistency check" rather than an "externally unforgeable proof"; achieving the latter would require a key management service and an independent signing service, which is already on the security-baseline roadmap. We believe stating the boundary explicitly is more in keeping with engineering integrity than overclaiming, and it speaks directly to the scoring dimension of "data consistency and observability".

### 12.5  Challenge five: deployment stability and "demo the binary that was verified"

The worst thing that can happen on demo day is "deploying a stale branch" — continuous integration all green while ECS runs last week's binary. We were once interrupted by a protocol-version mismatch between old and new during a 10k-scale Beijing test, which is why we elevated "deploy identity" to a first-class engineering problem. The solution has four parts: the version endpoint returns the protocol version, build identity, build time, and runtime environment; the continuous-delivery pipeline hard-checks the version endpoint's build identity against the expected value after deployment and treats a failure as a deployment that did not take effect; a separate pre-deploy preflight script runs the same check as a dry-run gate; and uploads are chunked with hash verification, avoiding the awkward "half uploaded, half failed" state under network jitter. With that in place, a judge can visit the version endpoint and confirm the freshness and authenticity of the live system at a glance.

---

## 13. Highlights and innovations

Following our mentor's advice that "one highlight taken to the extreme beats ten done superficially", we concentrated our differentiation in three places: seven auction mechanisms as product imagination, adjudicable and replayable correctness as engineering rigour, and the engineering discipline of high concurrency plus an AI sidecar.

### 13.1  Highlight one: from the English auction to seven auction mechanisms

We implemented all five rules the challenge requires, but that alone is not differentiation. We went back to the essence of "an auction is dynamic pricing" and introduced six additional mechanisms beyond public ascending bidding, all dispatched by one unified strategy registry, each with its own Lua script and strictly asserted demo, and all in the continuous-integration regression net.

| Mode | Economic archetype | Key technical implementation |
|---|---|---|
| English | Public ascending (the challenge's baseline mode) | Anti-snipe extension + a public leaderboard |
| Sudden death | Hammer on the first bid past the point | The extension window is zeroed automatically during rule normalization |
| First-price sealed | First-price sealed-bid auction | Bid amounts are not sent during LIVE and are revealed all at once at hammer |
| Second-price sealed | Vickrey auction | The same sealed path, settling at the second-highest price at hammer |
| Hybrid reveal | Half-hidden: hide the leader, show the runner-up | Server-side filtering of the current leader in both the leaderboard and broadcast |
| All-pay | Dollar auction | The runner-up forfeits virtual coins, no real order is created, and the UI is forced to show a compliance marker |
| Two-stage prequalify | Sealed warm-up → forms a floor price → English climax | A spawn-formal endpoint + a floor-price recommendation heuristic |

*Table 13-1  The seven auction modes and their economic archetypes*

What makes this set of modes a highlight is that it comes from deepening the product understanding of the challenge, not from copying the brief. The all-pay mode carries compliance risk, so we bounded it strictly as a demonstrative virtual-coin mechanism; drafted by Dai Zihan and approved by everyone, it requires the UI to display a "virtual coins · not a real payment · not gambling" marker, primarily in Chinese with English support. Delivering that compliance boundary clearly is itself a real landing of the bonus criteria.

### 13.2  Highlight two: adjudicable and replayable, audit-grade correctness

What we are after is not merely "being able to show a flashy demo", but "being able to prove to a judge why each bid in the last auction took effect, who won at what price and when, and whether any record has been altered". As chapter 12 describes, three-way consistent replay verification and the HMAC hash chain together provide that capability, the client's evidence card makes it visible to judges, and the public statement of the threat-model boundary is what makes the proof hold up under questioning. We deliberately distinguish an "internal consistency check" from an "externally unforgeable proof", and explicitly file the latter as follow-up work requiring a key management service and an independent signing service. Staying engineering-honest about our own limits, rather than dressing an internal hash chain in buzzwords like "blockchain", is itself the differentiator of this audit design. This item speaks directly to the "system availability, data consistency, and observability" scoring dimension.

### 13.3  Highlight three: high-concurrency core and the engineering discipline of an AI sidecar

On high concurrency, the system reaches ten thousand WebSocket connections in one room. A note on the measurement basis: the base requirement of challenge two is "a hundred or more people hammering the bid button at once", and the bonus item further sets a baseline of "over a thousand concurrent viewers in one live room"; this work measures ten thousand connections in one room against that bonus baseline (a thousand), ten times over. On top of that, coalesced broadcast in large rooms converges broadcast write amplification from growing linearly with bid bursts to being capped by the patch refresh rate; two-lane backpressure with typed close codes ensures a slow client cannot drag down the whole room; and the dual-channel design of HTTP-first with WebSocket fallback puts bid acks on the fastest path. On cross-client state synchronization, the HTTP command channel and the WebSocket fallback share the same client bid identifier, which together with last-sequence catchup after a disconnect and the protocol-version gate gives all four synchronization scenarios — web, mobile, reconnect, protocol upgrade — a unified fallback under one contract. On AI, the sidecar is one hundred percent out of adjudication, vision facts must be seller-confirmed before entering the core, the auctioneer degrades to a badge when offline, AI-offline end-to-end behaviour is hard-constrained in continuous integration, and coding-tool use is traceable throughout; voice bidding on the buyer side pushes AI further toward the demand side while strictly avoiding the compliance risk of "AI deciding the amount for the user" through explicit confirmation. On engineering discipline, we accumulated more than twenty-five design documents, four continuous-integration gates, and five chaos drills, and constrained every cross-module change with "contracts first, all-member approval"; hidden boundaries surfaced in review (fuzz testing, the WebSocket coalesced-broadcast race, the Vickrey payment fixture) were then formally folded into continuous integration (issue #228), turning review discipline into a long-lived regression gate.

Finally, we turned engineering credibility into UI elements the judges can see. The judges' director mode walks the whole auction loop with six buttons (last ten seconds, party A bids, party B retakes the lead, anti-snipe extension, hammer, evidence card), reusing production components with deterministic parameters injected, so demo day needs neither network nor seed data; the home page stages the hottest live session as a first-screen theatre; and the engineering info bar at the top of each room expands to show "connection OK · sequence · drift · bid rate · extension count", putting normally invisible engineering properties such as consistency and real-time behaviour right in front of the judges.

---

## 14. Additional material

### 14.1  Performance metrics and load-test results

All of the following data was collected on a Volcengine Beijing ECS instance (4 cores, 8 GiB), with Lumen, Redis 7, and MySQL 8 each running as a single process. We present it layered by test topology and give the measurement basis for every conclusion, avoiding blanket claims.

#### A. Server-side hot-path performance (loopback-isolated, application-layer baseline)

| Metric | Measured | Challenge budget / target |
|---|---|---|
| Concurrent WebSocket connections in one room | 10,000 | Bonus baseline 1,000 (ten times over) |
| Bid-ack latency, 95th percentile | 0.51 ms | < 80 ms |
| Broadcast latency, 95th percentile | 1.87 ms | < 500 ms |
| Lua script, 99th percentile | 1.49 ms | < 20 ms |
| Go handling, 99th percentile | 0.4 ms | < 5 ms (invariant P8) |
| Sequence gaps | 0 | 0 (hard constraint) |
| Backpressure force-closes | 0 | 0 (hard constraint) |
| Replay verification | consistent | consistent |
| Hash-chain verification | pass | pass |

*Table 14-1  Server-side hot-path performance (application-layer baseline)*

#### B. Real public-internet 10k concurrency — a clean pass (2026-06-07)

To verify that the application-layer conclusion still holds over the real public internet, we drove traffic from an out-of-region pay-as-you-go load machine (Shanghai) across a public elastic IP to the bare binary on the Beijing gateway, sidestepping the loopback-topology problem of a single host dialling itself. Under a topology of "9,900 viewers + 100 bidders, roughly five hundred bids per second", the run held ten thousand concurrent connections throughout, the auction closed cleanly, bid-ack latency at the 95th percentile was 0.46 ms, patch latency at the 95th percentile was 73 ms, and sequence gaps and backpressure force-closes were both zero. This is the system's first hard evidence of "real public-internet 10k", and together with the loopback and private-network evidence it gives three-way support for the conclusion of application-layer 10k-scale capacity in one room. The full report is `docs/reports/2026-06-07-tier2-public-loadtest-10k-20k.md`, tracked in issues #231 (public 10k pass, closed) and #233 (high activity and the capacity boundary, tracked separately).

#### C. Real public-internet 10k at high activity — SLO and correctness met, early exits declared honestly (scenario C / 2026-06-07)

To push past the lightweight "hundred bidders" baseline toward a load closer to a real live stream, we raised the bidding ratio to 4:6 on the same public topology — six thousand viewers plus four thousand active bidders, around twenty thousand bids per second end to end. The result: ten thousand connections OK, zero failures, peak concurrency ten thousand (steady state around 9,874), but about 1.3% (126) of connections closed proactively and exited before the auction ended; on the server side, under forty times the bid pressure, ack latency at the 95th percentile still held at 3.5 ms with patch latency at the 95th percentile at 58 ms, sequence gaps and backpressure force-closes both zero, and roughly 99.97% of doomed low bids were absorbed by the gateway's fast reject before ever reaching Lua adjudication. Our verdict is "high-activity 10k meets SLO and correctness, with early exits recorded separately as an honest boundary" — we do **not** describe this scenario as "zero early exits throughout". Spelling out that small tail is exactly this work's honest-boundary principle in practice.

#### D. Capacity-boundary probe — an honest boundary

We then raised active bidders from one hundred to ten thousand (targeting roughly fifty thousand bids per second, with about twenty thousand total connections) to observe how the system fails. The result: the single gateway process crashed and auto-restarted at a peak of roughly fifteen thousand seven hundred and seventy-seven (15,777) connections — but sequence gaps stayed at zero before and after the crash, no client was force-closed, and the auction state in Redis survived the restart. In other words, the process died but correctness never broke.

We treat this data point as a highlight rather than a blemish: it proves the system knows where its capacity boundary is, and that its posture under overload is a protected, graceful crash and recovery. Accordingly, our demo wording will not claim "one gateway stably supports twenty thousand connections at fifty thousand bids per second" — that is a boundary discovery, not a met target. Follow-up work will proceed along admission control, multi-gateway fanout, and memory-ceiling tuning.

### 14.2  Prompt strategy and agent flow

The system prompt for the auctioneer text stream tightly constrains the model's output boundary: a word limit, avoidance of a dynamic banned-word list, no promises beyond the current rules, no invented product facts (facts may only come from seller-confirmed vision extraction), and mandatory use of the provided server-side countdown. The user prompt injects context such as the trigger type, confirmed facts, current price, recent bidders, and remaining time.

```text
[system]
You are the "Lumen Auctioneer" in this live room. Rules:
- Stay within 100-200 characters and avoid the dynamic banned-word list
- Never promise anything beyond the current rules
- Never invent product facts (facts come only from seller-confirmed extraction)
- Always use the provided server-side countdown

[user]
Trigger: {trigger}   Item facts: {confirmed_facts}
Current price: {currentPriceCents}   Remaining: {remainingMs} ms   Extensions: {extendCount}
```

The prompt for vision fact extraction asks the model to look carefully at the image and output five to eight structured facts of no more than thirty characters each, mark uncertain items as pending confirmation, and never invent anything the image does not show. The automated path from listing to going live can be summarized as: the merchant uploads image URLs; within a 5-second hard timeout the sidecar calls the vision model (on timeout it prompts for manual entry rather than blocking); the fact draft comes back after passing the post-filter guardrail; and only after the merchant confirms each fact can the auction go live. The table below gives the AI sidecar's failure-fallback matrix.

| Failure case | Fallback |
|---|---|
| Vision call times out or errors | The UI shows a badge and the merchant fills in the facts manually |
| Language call times out or errors | Degrade to that trigger's preset short line; a line is still delivered |
| The AI sidecar process is entirely down | The end-to-end case verifies the auction path is one hundred percent unaffected |
| The model outputs banned content | The post-filter guardrail blocks it and sends that trigger's preset short line instead |

*Table 14-2  AI sidecar failure-fallback matrix*

### 14.3  Evaluation approach and sample results

The system's correctness is guaranteed jointly by four continuous-integration gates and a one-command demo regression. The four gates cover, respectively: backend race and full integration tests; convention guards (naming conventions, real-secret scanning, contract-file existence); an end-to-end demo on the full container stack plus chaos and load smoke; and frontend unit and component tests. The one-command demo regression brings up the whole stack in order, runs all seven modes, verifies the evidence chain and three-way consistency, executes the load and chaos smoke tests, and verifies that the bid path is fully decoupled from AI when AI is offline, finally printing a single green conclusion line meaning the demo path is intact. An excerpt of its sample output follows.

```text
demo-smoke [1/7] full stack up + seed              -- PASS
demo-smoke [3/7] English auction loop              -- PASS · 2 extensions -> SOLD
demo-smoke [3a/7] six mode demos                   -- ALL PASS
  sudden death   · no extension -> SOLD
  first-price sealed · reveal -> SOLD @12000
  second-price sealed · reveal -> SOLD @11000 (second highest)
  hybrid reveal  · broadcast hides the leader -> SOLD @12000 (true price)
  all-pay        · reveal -> SOLD @12000 -> no order (virtual coins)
  two-stage prequalify · sealed reveal -> spawns a formal English auction @11000
demo-smoke [4/7] evidence-chain verification       -- PASS (hash chain consistent)
demo-smoke [5/7] replay verification               -- PASS (stream = MySQL = snapshot)
demo-smoke [6/7] load + chaos smoke                -- PASS
demo-smoke [7/7] AI-offline end to end             -- PASS · bid path fully decoupled from AI
demo-smoke GREEN -- demo path intact
```

On resilience, we designed five chaos drills that inject faults into the AI sidecar, Redis, MySQL, the WebSocket gateway, and the timer process respectively, each with an explicit pass criterion, which turns "the system self-heals" into a machine-readable, regressable conclusion rather than a vague claim.

| Drill | Injected fault | Pass criterion |
|---|---|---|
| `chaos-ai` | The AI sidecar process is killed | The end-to-end bid case must pass; the bid path is fully decoupled from AI |
| `chaos-redis` | The Redis container restarts | Missed events are caught up from the last sequence number after the restart, with zero gaps in the event stream |
| `chaos-mysql` | The MySQL container restarts | The persistence worker retries and self-heals, with no event loss |
| `chaos-ws` | The gateway force-closes every connection | Clients bounce and reconnect, with typed close codes distinguishing backpressure from network causes |
| `chaos-timer` | The timer process pauses for about five seconds | The hammer is delayed by no more than five seconds, logs one error, and recovers on its own |

*Table 14-3  The five chaos drills and their pass criteria*

Worth noting: the adversarial tests Dai Zihan wrote genuinely caught two defects during collaboration — a contract gap where the hybrid mode's leaderboard endpoint leaked the current leader, and a key-type-guard gap in the sealed mode's close script — both fixed in the commits. This practice of "write the counter-test first and force the implementation to match the contract" speaks directly to the assessment of "unique or forward-looking thinking" and "failure fallback".

### 14.4  User feedback and internal testing

Internal testing for this work was mainly high-intensity peer review within the three-person team. All one hundred and eighty-plus pull requests in two weeks went through review, with cross-module contract changes strictly requiring all-member approval. On review density, every pull request went through at least one human review and four continuous-integration gates, while cross-module contract changes needed all-member approval and usually several rounds before merging. During review, adversarial tests were repeatedly submitted ahead of the fix, forcing the implementation to match the specification. The review and adversarial mechanisms not only caught contract gaps but also produced examples of second-round hardening: authentication for the metrics reset token evolved from a non-constant-time comparison to a constant-time comparison of SHA-256 digests (issue #224, hardened in follow-up #230 after peer review), a textbook case of "self-review → peer review → hardening"; and the local one-command demo smoke found the prequalify assertion out of sync with the recommender implementation (#225), which was then folded into the mode regression gate in continuous integration (#226), a textbook case of "record the spec drift first, then guard it with CI". We are especially committed to a culture of "facing failure honestly": when a public 10k-scale test failed for topology reasons, the team did not cover it up but submitted the full test report as a bounded claim and wrote the measurement basis into the demo materials, and only then achieved a clean pass after changing the test topology. Putting failures on record and writing boundaries down clearly is part of this work's material completeness and engineering credibility.

### 14.5  Sample AI inputs and outputs

To show what AI actually looks like in practice, here are two representative samples (taken from the demo script; on demo day the live run is authoritative), covering vision fact extraction and auctioneer line generation, and showing where human confirmation and the post-filter guardrail sit in each.

**Sample one: vision fact extraction (VLM)**

The input is a photo of a wristwatch. The vision model outputs a structured fact draft, each fact carrying four fields: field name, value, confidence (a float from 0 to 1), and whether it is high-risk (a boolean). The local development generator returns only two or three core facts such as category and authenticity, whereas on demo day the fact card preset in the demo script covers fuller entries such as brand, model, and condition; among them, "authenticity" is always marked high-risk with confidence zero and must be confirmed or filled in manually by the merchant. The merchant confirms and edits each item in the console, and only when all are confirmed can the auction move from scheduled to live. This flow embodies the product boundary we drew: the vision model produces only a draft awaiting confirmation, and final responsibility for the truthfulness of the product description always rests with the seller.

**Sample two: the auctioneer's hammer line (LLM)**

The input context is: trigger is hammer, the item is a particular wristwatch, the final price is 11,800 yuan, and the winner's display name is a given buyer. From that the language model generates a hammer line of no more than eighty characters, calling out the hammer price, congratulating the winner, and teasing the next session; the line first passes the post-filter guardrail (no banned words, no promises beyond the rules, no invented product facts, and the amount and winner taken from server-side facts rather than model invention), and only then is streamed character by character to the room. If the guardrail rejects it or the model times out, the line degrades to a preset short fallback — each trigger has its own generic fallback sentence, for example "Sold — congratulations to the winner." for the hammer case — so from the user's point of view a line still arrives, just no longer dependent on the model output; the bid path and the state machine are entirely unaffected. This should be distinguished from the next case: what is described here is the fallback copy for a single failed call, whereas the "AI offline" of section 11.5 refers to the whole sidecar process being unavailable and degrading to a status badge. They are degradations at different levels.

---

## 15. Scoring alignment overview

To let judges cross-check quickly by weight, the following lists our self-assessment and the main evidence pointers for the four scoring dimensions and the bonus items. Section numbers in the evidence pointers refer to sections of this report.

### 15.1  Implementation and engineering completeness (50%)

| Assessment point | Self-assessment | Evidence pointer |
|---|---|---|
| A complete engineering chain (collection → governance → backend → gateway → frontend) | Complete | Chapter 10 architecture + chapter 5 flow |
| Bid validation and state-machine control | Strict | 12.1 atomic adjudication + 12.2 state machine and invariants |
| System availability (disconnect/reconnect, failure fallback) | Strong | 12.3 catchup and backpressure + five chaos drills (chaos-ai / chaos-redis / chaos-mysql / chaos-ws / chaos-timer) |
| Performance, stability, data consistency | Quantitatively met | 14.1 B (real public 10k at 0.46 ms, zero sequence gaps) + 14.1 C (high-activity 4:6, ack p95 3.5 ms) + 12.4 three-way replay and hash chain |
| Observability (monitoring, alerting) | Complete | Metrics endpoint + version endpoint + replay verification + the alerting path (4.5) |

### 15.2  Technical depth and innovation (25%)

| Assessment point | Self-assessment | Evidence pointer |
|---|---|---|
| Technology choices and fit | Strongly aligned | 10.2 selection rationale (Go vs Node, Lua vs distributed lock, React+TS, Redis and MySQL responsibility split) |
| Targeted optimization of core challenges | On point | 12.3 coalesced broadcast / two-lane backpressure |
| Room-level WebSocket routing isolation | Implemented | Chapter 10 architecture (one gateway, many rooms) |
| Bid idempotency design | Implemented | 12.1 dedupe + the per-auction unique constraint + 12.4 hash chain |
| Innovative differentiation | Standout | Chapter 13 highlights one and two |

### 15.3  AI usage and landed effect (15%)

| Assessment point | Self-assessment | Evidence pointer |
|---|---|---|
| Reasonable AI-tool use and scenario fit | Fits | 11.1 vision fact extraction + the language auctioneer + 4.2 voice bidding |
| A disciplined, traceable process | Disciplined | 11.6 usage log + the AI-offline gate + the `ai_usage_logs` table |
| Reasonableness of the AI code contribution rate | Key decisions one hundred percent human | 11.6 |
| Completeness of AI in the business | Covers publish / live / settlement / buyer side | 4.2 voice bidding + 11.3 four triggers + 11.4 vision drafts + 14.5 samples |
| AI failure fallback | Hard CI constraint + guardrail + degradation | 11.5 offline gate + 14.2 fallback matrix |

### 15.4  Project material completeness (10%)

| Assessment point | Self-assessment | Evidence pointer |
|---|---|---|
| Design documentation | More than twenty-five design documents | The docs directory |
| Demo video (both sides + high concurrency) | A three-minute main video + a local fallback recording | Chapter 7 |
| Repository discipline | Trunk-based development + four gates all green | Chapter 8 + 14.3 |
| Clarity of exposition | This report (docx + md, one source) + a README of nearly twenty sections | Chapter 9 + the whole document |

### 15.5  Bonus-item alignment

| Bonus direction | Self-assessment and evidence |
|---|---|
| Deep use of full-stack AI tooling | Claude Code and Codex used to their respective strengths throughout development, with human control at key decision points and a traceable usage log (11.6) |
| An extreme bidding-atmosphere experience | Lead / outbid feedback, price rollover, leaderboard flight, heartbeat sound, red pulsing ring (4.2 + chapter 5) |
| Voice bidding (extending AI to the buyer side) | Browser SpeechRecognition + explicit confirmation + the same bid channel (4.2 + 13.3) |
| Redis tiering and read/write separation | Redis hot path + MySQL projection (chapter 10 + 12.1) |
| Distributed lock / bid idempotency | Lua atomicity + client-identifier dedupe + the per-auction unique constraint (12.1 + 12.4) |
| WebSocket heartbeat keepalive | An application-layer heartbeat prevents OS-level long blocking reads, with typed close codes distinguishing backpressure from network disconnects (12.3) |
| Over a thousand concurrent viewers in one room | Ten thousand connections over the real public internet, ten times the bonus baseline of a thousand (14.1 B) |
| Real public-internet 10k at high activity, 4:6 | ack p95 3.5 ms with 4,000 simultaneous bidders, SLO and correctness met, 1.3% early exits recorded honestly (14.1 C) |
| Honest declaration of the capacity boundary | The boundary at a peak of roughly 15,777 connections and a target of fifty thousand bids per second presented truthfully (14.1 D) |
| A demo stage for judges | The judges' director mode at `/showcase`, the expandable engineering info bar, and the theatre-style home page make engineering credibility a UI element judges can see (end of 13.3) |

---

## 16. Key milestones and honest-boundary statement

### 16.1  Key milestones

The project started from the challenge briefing and was split trunk-driven into eleven milestones, T0 through T10, consistent with the collaboration discipline described in chapter 3. The table below gives each milestone's dates and main deliverables.

| Milestone | Dates | Main deliverables |
|---|---|---|
| T0–T2 | 5.20–5.27 | First version of the contracts and state machine written down (the proto contract files) |
| T3–T4 | 5.27–6.01 | The bid adjudication Lua scripts, the replay verifier, and the HMAC hash chain |
| T5–T6 | 6.01–6.03 | The WebSocket gateway, room isolation, and coalesced broadcast for large rooms |
| T7 | 5.31–6.04 | AI sidecar integration and the AI-offline gate |
| T8 | 6.04–6.05 | Load testing and the 10k-scale test topology |
| T9 | 6.05–6.06 | Chaos drills and the deploy-identity gate |
| T10 | 6.06–6.09 | The judges' demo stage and submission materials (including voice bidding, the new frontend merge, the Tier-2 public load test, and this report) |

*Table 16-1  T0–T10 development milestones*

The competition schedule those milestones map onto is: the challenge briefing on 20 May, mentor assignment on 21 May, the challenge window from 20 May to 10 June, and project demos on 11–12 June.

### 16.2  Honest-boundary statement

We believe stating the system's capability boundaries clearly is just as important as stating its highlights. The following five points are this work's explicit boundaries today; all are recorded in the repository and approved by every member.

- **Capacity boundary**: ten thousand connections in one room at the application layer has cleanly passed over the real public internet; a single gateway process crashes and restarts at a target of roughly fifty thousand bids per second and a peak of roughly fifteen thousand seven hundred and seventy-seven (15,777) connections, but correctness never breaks. That is a boundary discovery rather than a met target, and it feeds into the admission-control and multi-gateway-fanout roadmap.
- **Account authentication**: real Douyin single sign-on is not integrated; the current login endpoint is a simplified mode that mints a buyer token from a nickname, for challenge-demo purposes only.
- **Payment channel**: no real payment is integrated; the order's "payment" is simulated and is stated explicitly on the evidence card.
- **All-pay compliance**: it is only a demonstrative virtual-coin mechanism, the UI is forced to display "virtual coins · not a real payment · not gambling", and the boundary is written into the evidence-card contract and approved by every member. This work is not a gambling product.
- **Test environment and reproducibility**: every performance number in this report was collected on a Volcengine Beijing ECS instance (4 cores, 8 GiB) running single-process bare binaries; parallel multi-gateway fanout, cross-region replicas, and enterprise dedicated links were not verified within the scope of this work. Of these, the private-network 10k run (Tier-1) has a full one-command reproduction handbook at `docs/runbooks/beijing-tier1-10k-demo.md`, covering the jump host, load-machine configuration, token sharding, and run commands; the topology and data for the real public-internet 10k run (Tier-2) from an out-of-region load machine to the Beijing gateway's elastic IP, and for the 20k capacity boundary, are in `docs/reports/2026-06-07-tier2-public-loadtest-10k-20k.md` and issue #233, with a standalone reproduction handbook listed as follow-up work.

---

## 17. A five-minute check for judges

If a judge is short on time, the following order completes a check of this work in five minutes.

1. Open the production entry and the version endpoint, and confirm the deploy identity is fresh and the protocol version and build identity match (about half a minute).
2. Open the judges' director mode (`/showcase` if it is deployed that day, otherwise the home page plus room combination, which is also reachable after a one-command local start) and walk the auction loop in six steps, watching the two-phone view, the anti-snipe banner, the engineering info bar, and the evidence card (about two minutes).
3. Open the repository and check that the four continuous-integration gates are green and review the commit list (about half a minute).
4. (Optional) In another terminal, clone the repository and run the one-command demo regression; in about three to four minutes it runs all seven modes, chaos, load, and AI-offline. This step can run in parallel with the above and does not count toward the five minutes.
5. Read the green conclusion at the bottom of the one-command demo regression output, which counts as system-level end-to-end verification (about half a minute).
6. Skim the real public-internet Tier-2 measurement summary in `docs/reports/2026-06-07-tier2-public-loadtest-10k-20k.md` (the three scenarios: 10k baseline / 10k at 4:6 high activity / 20k storm) plus issues #233 and #231, and check the 10k data against the honest statement of the capacity boundary (about one minute).

---

> This report was finalized by team Mythos on 9 June 2026. If sections need to be added, scoring details aligned, or wording adjusted, that can continue during the final sprint before the demo.
