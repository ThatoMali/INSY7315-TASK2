# SANParks FRIMS — Field Ranger & Incident Management System

Node.js + Express + SQLite (better-sqlite3) + JWT, with a single-page front-end served from the same app. Includes offline-first data capture, server-side severity triage, **SOS emergency dispatch, integrated payments for permits/fines**, and a built-in rule-based AI assistant.

## 🚀 Run it (2 minutes)

```bash
npm install
npm start
# open http://localhost:3000
Requires Node 20 or newer. The SQLite database (data/frims.db) is created and seeded automatically on first run. No .env file is needed locally.

Run the tests:

bash
npm test
🏗 System Architecture























Demo Accounts
Role	Username	Password	Lands on
Field Ranger	t.nkosi	Ranger@123	Mobile log-incident screen
Section Ranger	s.mahlangu	Ranger@123	Dashboard (Kruger South)
Regional Ecologist	ecologist	Eco@123	Dashboard (all sections, read-only) + audit log
System Administrator	admin	Admin@123	Dashboard + user management + audit log
Others: m.dlamini, k.vanwyk, n.zulu (field rangers, Kruger South), j.botha (section ranger, Kruger North), p.molefe (field ranger, Kruger North) — password Ranger@123.

📱 Live Demo & Screenshots
1. Mobile Incident Logging & SOS
Rangers can log incidents from the field. The screen captures GPS, allows a photo upload (downscaled for weak connections), and shows a real-time AI severity tag. A dedicated SOS button allows rangers to instantly broadcast their GPS coordinates and trigger a critical emergency alert to all command staff. It is fully responsive for phone screens.

<img width="320" height="766" alt="Mobile Ranger Screen" src="https://github.com/user-attachments/assets/a4248633-9eac-43fa-a217-c94a8150ad8f" />
2. Automated Escalation & Alerts
If the server-side triage detects a High severity incident (or an SOS is triggered), it is automatically set to Escalated and raises an alert for section rangers.

<img width="299" height="283" alt="Escalated Incident and Alert" src="https://github.com/user-attachments/assets/90429549-9f2c-4975-bca8-11dae254910f" />
3. Payments & Permits Gateway
Tourists and staff can pay for conservation fees, overnight permits, and settle spot fines directly through an integrated Stripe/PayFast gateway. The system automatically generates a digital receipt and updates the visitor's dashboard.

<!-- Placeholder for Payment Gateway Screenshot --><img width="800" alt="Payment Gateway Checkout" src="YOUR_PAYMENT_GATEWAY_SCREENSHOT_URL_HERE" />
4. AI Chatbot Assistant
A built-in, context-aware assistant helps users navigate the system. It answers how-to questions, queries live database stats (scoped to the user's role), and can score incident descriptions on the fly.

<!-- Placeholder for Chatbot Screenshot --><img width="400" alt="FRIMS AI Chatbot Assistant" src="YOUR_CHATBOT_SCREENSHOT_URL_HERE" />
5. Audit Trail
Every action (login, incident creation, status change, user deactivation, fine payment) is logged immutably for compliance.

<img width="898" height="630" alt="Audit Trail" src="https://github.com/user-attachments/assets/21c68015-a183-4238-8909-429de56ba5be" />
🛡 What each role can do
Capability	Field Ranger	Section Ranger	Ecologist	Admin
Trigger SOS Emergency Broadcast	✔			
Log incidents (GPS, photo, live severity tag, works offline)	✔			
See own incidents	✔			
See incidents, stats, map, alerts		own section	all (filter by section)	all (filter by section)
Escalate / resolve / reopen incidents		own section		✔
Export CSV / print PDF		own section	all	all
View audit log			✔	✔
Process Payments & Fines		✔		✔
Create / edit / deactivate users				✔
Scoping is enforced on the server (src/scope.js), not just hidden in the UI.

How it works
SOS & Severity Triage: SOS pings bypass standard queues and trigger an immediate High-severity alert. Standard incidents are calculated server-side (src/triage.js, rule-based: type + keywords). The client cannot choose severity or status.

Offline Queue: If the network is down, reports are saved in localStorage and auto-synced later. A client_id makes retries idempotent, so nothing is duplicated.

Payments Gateway: Secure webhook integration handles card processing for permits. PII is never stored on our servers (PCI-DSS compliant); we only store the transaction token and receipt ID.

Built-in Chatbot: A deterministic, offline assistant (src/routes/chat.js). It answers how-to questions, scores incident descriptions live, and queries the database respecting the user's scope (e.g., "how many incidents are open?").

Security:

bcrypt hashes, strict Content-Security-Policy.

JWT re-checked against the DB on every request (deactivating a user takes effect immediately).

Parameterised SQL, HTML-escaped output, CSV formula-injection protection.

Login rate-limiting (10 fails / 15 min), image-type whitelist.

Project layout
text
server.js              start-up
src/app.js             express app (headers, routes, static files)
src/db.js              schema, indexes, seed data
src/auth.js            JWT + bcrypt helpers
src/middleware.js      authenticate, authorize, validate, error handlers
src/scope.js           role-based data scoping
src/triage.js          severity rules        
src/audit.js           audit trail
src/routes/            auth, incidents, users, alerts, reports, audit, chat, payments
public/                index.html, styles.css, js/api.js, js/app.js, vendor/ (Leaflet, Chart.js)
tests/api.test.js      unit + integration tests (node:test)
render.yaml            Render blueprint       
.github/workflows/     CI + deploy
REST API (all JSON; except login/health need Authorization: Bearer <token>)
Method & path	Purpose	Roles
POST /api/auth/login · GET /api/auth/me	sign in / current user	any
POST /api/sos	Trigger emergency broadcast	field ranger
GET /api/incidents (status,severity,type,section_id,from,to,q,limit)	list (scoped)	any
GET /api/incidents/stats · GET /api/incidents/:id	dashboard stats / detail + audit trail	any (scoped)
POST /api/incidents/triage	severity preview	any
POST /api/incidents	log incident	field & section ranger
PATCH /api/incidents/:id	change status/severity	section ranger, admin
GET /api/alerts · PATCH /api/alerts/:id/read · PATCH /api/alerts/read-all	alerts	section ranger, ecologist, admin
GET /api/reports/incidents.csv (or .json)	export	section ranger, ecologist, admin
POST /api/payments/checkout	Create payment intent	any
POST /api/payments/webhook	Gateway callback	public (signed)
GET/POST /api/users · PATCH/DELETE /api/users/:id · GET /api/users/sections	user admin	admin
GET /api/audit	audit log	admin, ecologist
POST /api/chat	AI assistant	any
GET /api/health	health check	public
☁️ CI/CD & Deploy to Render
This project uses GitHub Actions for continuous integration and Render for hosting.

<!-- Placeholder for GitHub Actions Screenshot --><img width="800" alt="CI/CD Pipeline" src="YOUR_GITHUB_ACTIONS_SCREENSHOT_URL_HERE" />
Push to GitHub. CI runs tests on Node 22 and 24.

In Render, choose New → Blueprint and select the repo (render.yaml configures everything; JWT_SECRET is generated).

Copy the Render Deploy Hook URL into a GitHub repo secret named RENDER_DEPLOY_HOOK. Every push to main that passes tests deploys automatically.

Branching strategy: feature/* → PR into develop → PR into main.

Render free plan note: the disk is ephemeral, so data and photos reset when the service restarts (demo data is re-seeded). See comments in render.yaml for adding a persistent disk.

⚠️ Before real-world use
Remove the demo-account buttons from public/index.html and change the seeded passwords.

The map needs internet access for OpenStreetMap tiles; everything else is served locally.

Uploaded photos are served from /uploads/<random name> without a login (names are unguessable); put them behind auth if that is not acceptable.

Payment Gateway: Swap the test API keys for live production keys (e.g., PayFast/Stripe) in the environment variables.
