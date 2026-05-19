Cargo offers a suite of commands for project management. 
Rust Documentation
Rust Documentation
cargo new <project_name>: Creates a new Cargo package in a new directory.
cargo init: Creates a new Cargo package in the current directory.
cargo build: Compiles the project without running it, placing the executable in target/debug.
cargo check: Checks the project for errors without producing an executable, which is faster than building.
cargo test: Executes unit and integration tests.
cargo doc: Builds the project's documentation.

cargo build --release


CREATE TABLE email_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    access_token TEXT,
    refresh_token TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    last_sync BIGINT
);


CREATE TABLE email_accounts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    email TEXT NOT NULL,
    provider TEXT DEFAULT 'gmail',

    access_token TEXT,
    refresh_token TEXT,
    token_expiry TIMESTAMP,

    last_sync TIMESTAMP,

    created_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(user_id, email)
);

CREATE TABLE meetings (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);


CREATE TABLE emails (
    id SERIAL PRIMARY KEY,
    gmail_id TEXT NOT NULL,
    account_id INTEGER,
    subject TEXT,
    sender TEXT,
    receiver TEXT,
    body TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(account_id, gmail_id)
);


CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    sender_id INT,
    receiver_id INT,
    content TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);


CREATE TABLE meetings (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

http://localhost:8080/gmail/login
http://localhost:8080/emails


http://localhost:8080/gmail/login


.. Keeps the data in tables 
docker-compose down
docker-compose up --build


⚡ BONUS: Use cargo watch (🔥 game changer)

Install:

cargo install cargo-watch

Run:

cargo watch -x run

👉 auto rebuild on file change
👉 no docker rebuild needed


src/
├── main.rs
├── prelude.rs

├── config/          # env, constants
├── models/          # DB structs
├── dto/             # request/response shapes (NEW)

├── handlers/        # HTTP layer ONLY
├── services/        # business logic (IMPORTANT)
├── repositories/    # DB queries (NEW, CLEAN)

├── auth/            # oauth + jwt
├── utils/



cargo build ---> cargo check

install:
cargo install cargo-watch

for stopped app: cargo watch -x check
for running app: cargo watch -x run


cargo watch -x run


➜  frontend git:(main) ✗ pkill -f vite
➜  frontend git:(main) ✗ lsof -i :5173

Front-end URL: Cloudfront: https://d2j48xaszdfk51.cloudfront.net/login

Back-end: ECS: http://52.23.197.236:8080/




13656* cargo clippy
13657* cd backend
13658* cargo clippy
13659* cargo fmt --all\ncargo clippy --all -- -D warnings
13660* cargo fmt
13661* cargo lint




.. Always do this before commit
cargo fmt
cargo clippy -- -D warnings
cargo check

cargo install cargo-modules
cargo modules structure
cargo modules structure --no-fns
cargo modules structure --no-fns --no-types --no-traits
cargo modules structure --focus-on email
cargo modules structure --focus-on chat
cargo modules structure --max-depth 2
cargo modules structure --no-fns --max-depth 3


Wayve/
└── 📂 backend/
    ├── 📂 src/
    │   ├── 📂 call/
    │   │   └── 📂 handlers/
    │   │       └── 📄 fn call_ws          # WebSocket signaling for calls
    │   ├── 📂 chat/
    │   │   └── 📂 handlers/
    │   │       ├── 📄 fn chat_ws          # Real-time chat messaging
    │   │       ├── 📄 fn get_messages     # History retrieval
    │   │       └── 📄 ChatSession         # Session state management
    │   ├── 📂 drive/
    │   │   └── 📂 handlers/
    │   │       ├── 📄 fn upload_file
    │   │       └── 📄 fn get_files
    │   ├── 📂 email/
    │   │   ├── 📁 auth/
    │   │   │   └── 📄 refresh_access_token
    │   │   ├── 📁 handlers/
    │   │   │   ├── 📄 gmail_login         # OAuth Initiation
    │   │   │   ├── 📄 oauth_callback      # Token exchange
    │   │   │   ├── 📄 send                # Outbound mail
    │   │   │   ├── 📄 get_me              # Profile info
    │   │   │   └── 📄 save_public_key     # End-to-end encryption setup
    │   │   ├── 📁 sync/
    │   │   │   ├── 📄 sync_all            # Full mailbox synchronization
    │   │   │   ├── 📄 process_batch       # Background processing logic
    │   │   │   └── 📄 fetch_ids/details   # IMAP/API fetching logic
    │   │   └── 📁 utils/
    │   │       ├── 📄 extract_body
    │   │       └── 📄 decode_base64       # MIME handling
    │   ├── 📂 routes/                     # API Endpoint definitions
    │   │   ├── 📄 account / auth
    │   │   └── 📄 email / user
    │   ├── 📂 security/
    │   │   ├── 📄 encryption              # Likely PGP or AES logic
    │   │   └── 📄 jwt                     # Session token management
    │   ├── 📂 scheduler/
    │   │   └── 📄 handler                 # Cron/Task scheduling
    │   ├── 📄 main.rs                     # Entry point & Server setup
    │   └── 📄 cargo.toml                  # Dependencies
    └── ...


├── 📂 frontend/
│   ├── 📂 src/
│   │   ├── 📂 api/
│   │   ├── 📂 assets/
│   │   ├── 📂 auth/
│   │   ├── 📂 call/
│   │   ├── 📂 chat/
│   │   ├── 📂 components/
│   │   ├── 📂 crypto/
│   │   ├── 📂 drive/
│   │   ├── 📂 emails/
│   │   ├── 📂 home/
│   │   ├── 📂 pages/
│   │   ├── 📂 scheduler/
│   │   ├── 📂 security/
│   │   ├── 📄 api.ts
│   │   ├── 📄 App.tsx
│   │   └── 📄 config.ts
│   └── ...
├── 📂 nginx/
│   └── 📄 nginx.conf
├── 📄 docker-compose.yml
└── 📄 init.sql


modules/
  email/
    api/
    service/
    repo/
    integration/

  chat/
    websocket/
    service/
    repo/

  drive/
  scheduler/


email/
├── api/
│   └── email_api.rs
├── services/
│   ├── email_service.rs
│   └── email_sync_service.rs
├── repositories/
│   └── email_repo.rs
├── integrations/
│   └── gmail_client.rs



Make body_encrypted/body_iv nullable in init.sql + provide migration SQL

Refactor sync.rs to fetch headers only (format=metadata)

Create body_worker.rs that fills missing bodies in the background

Add GET /api/emails/{id}/body handler (on-demand body fetch + AES decrypt)

Update routes/email.rs list response (drop body, add has_body)

Wire body worker + new endpoint in main.rs

Update frontend Emails.tsx to fetch body on click

Run cargo check and tsc to verify everything compiles




File	Change
init.sql	Added idx_emails_pending_body partial index for body_encrypted = ''
backend/src/email/sync.rs	Replaced fetch_email_detail with fetch_headers_only using format=metadata. Inserts rows with body_encrypted='' sentinel.
backend/src/email/body_worker.rs	NEW — background worker, 40 concurrent fetches per account, 200/account/iteration, idle 5s when nothing pending
backend/src/email/handler.rs	Added GET /api/emails/{id}/body — auth + ownership → return cached AES-decrypted body, or fetch from Gmail on-demand and persist
backend/src/email/mod.rs	Exposed body_worker
backend/src/routes/email.rs	Dropped body_encrypted/body_iv from list, added has_body and gmail_id
backend/src/main.rs	Registered get_email_body + start_body_worker(pool)
frontend/src/emails/Emails.tsx	openEmail now fetches /api/emails/:id/body, shows "Loading…" state, then runs WAYVE_SECURE_V1 RSA decrypt as before
What you need to do before this works
Wipe existing email bodies (you said wipe and re-sync):


UPDATE emails SET body_encrypted = '', body_iv = '';
UPDATE email_accounts SET last_sync = NULL;
The first line marks every existing email as "needs body fetched" so the body worker picks them up. The second forces the header sync to re-walk all message IDs (cheap; metadata-only).

Apply the new partial index — running init.sql is idempotent thanks to IF NOT EXISTS, but psql -f init.sql may complain about earlier non-IF-NOT-EXISTS lines. Just run the new index manually:


CREATE INDEX IF NOT EXISTS idx_emails_pending_body
ON emails (account_id, id) WHERE body_encrypted = '';
Restart the backend so the body worker spawns and the new route registers.

After that, click any email — you'll get either an instant decrypt (if the worker already filled it) or a brief "Loading…" while the on-demand fetch runs. Background worker chews through the rest at ~40 concurrent fetches per account.



Zoom:
Account ID: JG1En7IbQiqv3MdugcE8ww
Client ID: 2AA4vlpNS4Cshw2huqUTQ
Client Secret: 0pzG2mxPa3ydbgmZGmKK1rNL1YtxuiK1
Secret Token: AxcmVknsROGL4A8l1kEegw



show all files and folders in tree structure:
tree -L 2
Show only folders:
tree -L 2 -d

flake.nix code:
{
  description = "Wayve Fullstack App (Rust + React + Postgres)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Rust overlay (latest toolchain)
    rust-overlay.url = "github:oxalica/rust-overlay";

    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ rust-overlay.overlay ];

        pkgs = import nixpkgs {
          inherit system overlays;
        };

        rustToolchain = pkgs.rust-bin.stable.latest.default;

      in
      {
        # ===============================
        # 🧪 DEV ENVIRONMENT
        # ===============================
        devShells.default = pkgs.mkShell {
          buildInputs = [
            rustToolchain

            # Rust tooling
            pkgs.cargo
            pkgs.clippy
            pkgs.rustfmt

            # Node (React/Vite frontend)
            pkgs.nodejs_20
            pkgs.pnpm

            # DB + native deps
            pkgs.postgresql
            pkgs.openssl
            pkgs.pkg-config

            # Optional but useful
            pkgs.git
            pkgs.curl
            pkgs.docker-compose
          ];

          # 🔥 ENV for SQLx + OpenSSL
          shellHook = ''
            export DATABASE_URL=postgres://postgres:postgres@localhost:5432/wayve
            export OPENSSL_DIR=${pkgs.openssl.dev}
            export OPENSSL_LIB_DIR=${pkgs.openssl.out}/lib
            export OPENSSL_INCLUDE_DIR=${pkgs.openssl.dev}/include

            echo "🚀 Wayve Dev Environment Ready"
            echo "Rust: $(rustc --version)"
            echo "Node: $(node --version)"
          '';
        };

        # ===============================
        # 🏗️ BUILD RUST BACKEND
        # ===============================
        packages.backend = pkgs.rustPlatform.buildRustPackage {
          pname = "wayve-backend";
          version = "0.1.0";

          src = ./backend;

          cargoLock = {
            lockFile = ./backend/Cargo.lock;
          };

          buildInputs = [
            pkgs.openssl
            pkgs.pkg-config
          ];
        };

        # ===============================
        # 🌐 BUILD REACT FRONTEND
        # ===============================
        packages.frontend = pkgs.stdenv.mkDerivation {
          pname = "wayve-frontend";
          version = "0.1.0";

          src = ./frontend;

          buildInputs = [
            pkgs.nodejs_20
            pkgs.pnpm
          ];

          buildPhase = ''
            pnpm install
            pnpm build
          '';

          installPhase = ''
            mkdir -p $out
            cp -r dist/* $out/
          '';
        };

        # ===============================
        # 🔥 DEFAULT PACKAGE
        # ===============================
        packages.default = self.packages.${system}.backend;

      });
}





AES_KEY=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
AES_HKDF_SALT=wayve-production-stable-salt
DATABASE_URL=postgres://wayve_user:wayve_password@postgres_db:5432/wayve_dev


git add .
git commit -m "release: v0.1.0"
git tag v0.1.0
git push origin main --tags



npm install lucide-react



Google gemini API key:
API Key
AIzaSyAxIJzNyPssV8czY34WbJCvvv3OJeNlEqI
Name
wayve_api_key
Project name
projects/151840850497
Project number
151840850497

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent" \
  -H 'Content-Type: application/json' \
  -H 'X-goog-api-key: AIzaSyAxIJzNyPssV8czY34WbJCvvv3OJeNlEqI' \
  -X POST \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "Explain how AI works in a few words"
          }
        ]
      }
    ]
  }'




Uncomment the three deps in Cargo.toml:51-53
Move the block comment in logger.rs and tracing_root.rs back to expose the original code
Uncomment pub mod tracing_root; in observability/mod.rs
Uncomment the two imports + the .wrap(TracingLogger…) line in main.rs
Logs to terminal will be silent for now. If you want temporary visibility while tracing is disabled, you can add eprintln! at key spots — let me know and I'll wire those in.



App start
→ /api/me
→ RSA key generation
→ IndexedDB save
→ export public key
→ POST /api/save-public-key
→ THEN render app


docker system prune -a










{
        "Version": "2008-10-17",
        "Id": "PolicyForCloudFrontPrivateContent",
        "Statement": [
            {
                "Sid": "AllowCloudFrontServicePrincipal",
                "Effect": "Allow",
                "Principal": {
                    "Service": "cloudfront.amazonaws.com"
                },
                "Action": "s3:GetObject",
                "Resource": "arn:aws:s3:::tideon-s3-bucket/*",
                "Condition": {
                    "StringEquals": {
                      "AWS:SourceArn": "arn:aws:cloudfront::339713009139:distribution/E1EULUZC0EGV1H"
                    }
                }
            }
        ]
      }


{
        "Version": "2008-10-17",
        "Id": "PolicyForCloudFrontPrivateContent",
        "Statement": [
            {
                "Sid": "AllowCloudFrontServicePrincipal",
                "Effect": "Allow",
                "Principal": {
                    "Service": "cloudfront.amazonaws.com"
                },
                "Action": "s3:GetObject",
                "Resource": "arn:aws:s3:::tideon-s3-bucket/*",
                "Condition": {
                    "StringEquals": {
                      "AWS:SourceArn": "arn:aws:cloudfront::339713009139:distribution/E1EULUZC0EGV1H"
                    }
                }
            }
        ]
      }




docker buildx build \
  --platform linux/amd64 \
  -t 339713009139.dkr.ecr.us-east-1.amazonaws.com/tideon_ecr:v3 \
  --push .



Email:maheshiv1999@gmail.com
App password: cbtq vrls popq eowj




cargo fmt --all
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo check
cargo check --all-targets --all-features -- --check



# Frontend (no infra required)
cd frontend && npm test

# Backend unit tests only (no DB required)
cargo test --manifest-path backend/Cargo.toml --bin rwayve security

# Backend full suite (needs Postgres + optional MailHog)
docker compose -f infra/docker-compose.yml up -d postgres_db
docker compose -f infra/docker-compose.yml --profile mail up -d mailhog
psql -f infra/postgres/init.sql
DATABASE_URL=postgres://postgres:postgres@localhost:5432/rwayve \
  MAILHOG_API=http://localhost:8025 \
  MAILHOG_SMTP_HOST=localhost MAILHOG_SMTP_PORT=1025 \
  cargo test --manifest-path backend/Cargo.toml




wayve/
│
├── Cargo.toml
├── Cargo.lock
│
├── apps/
│   ├── api/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── main.rs
│   │
│   ├── websocket/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── main.rs
│   │
│   ├── worker/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── main.rs
│   │
│   └── cli/
│       ├── Cargo.toml
│       └── src/
│           └── main.rs
│
├── services/
│   ├── auth/
│   ├── email/
│   ├── chat/
│   ├── scheduler/
│   ├── drive/
│   ├── ai/
│   ├── notifications/
│   └── search/
│
├── shared/
│   ├── config/
│   ├── database/
│   ├── security/
│   ├── observability/
│   ├── cache/
│   ├── errors/
│   ├── models/
│   ├── types/
│   └── utils/
│
├── frontend/
│
├── infra/
│   ├── docker/
│   ├── nginx/
│   ├── terraform/
│   ├── kubernetes/
│   └── aws/
│
├── scripts/
│
├── docs/
│
└── tests/






Gmail
Proton Mail
Outlook
Yahoo Mail
iCloud Mail
Fastmail
Zoho Mail
Tuta Mail
Mailfence
Posteo
StartMail
Hushmail


openssl rand -hex 64




cat /etc/nginx/sites-enabled/default 
##
# You should look at the following URL's in order to grasp a solid understanding
# of Nginx configuration files in order to fully unleash the power of Nginx.
# https://www.nginx.com/resources/wiki/start/# https://www.nginx.com/resources/wiki/start/topics/tutorials/config_pitfalls/
# https://wiki.debian.org/Nginx/DirectoryStructure
#
# In most cases, administrators will remove this file from sites-enabled/ and
# leave it as reference inside of sites-available where it will continue to be
# updated by the nginx packaging team.
#
# This file will automatically load configuration files provided by other
# applications, such as Drupal or Wordpress. These applications will be made
# available underneath a path with that package name, such as /drupal8.
#
# Please see /usr/share/doc/nginx-doc/examples/ for more detailed examples.
##

# Default server configuration
#



server {
	listen 80 default_server;
	listen [::]:80 default_server;

	# SSL configuration
	#
	# listen 443 ssl default_server;
	# listen [::]:443 ssl default_server;
	#
	# Note: You should disable gzip for SSL traffic.
	# See: https://bugs.debian.org/773332
	#
	# Read up on ssl_ciphers to ensure a secure configuration.
	# See: https://bugs.debian.org/765782
	#
	# Self signed certs generated by the ssl-cert package
	# Don't use them in a production server!
	#
	# include snippets/snakeoil.conf;

	root /var/www/html;

	# Add index.php to the list if you are using PHP
	index index.html index.htm index.nginx-debian.html;

	server_name _;

	location / {
		# First attempt to serve request as file, then
		# as directory, then fall back to displaying a 404.
		try_files $uri $uri/ =404;
	}

	# pass PHP scripts to FastCGI server
	#
	#location ~ \.php$ {
	#	include snippets/fastcgi-php.conf;
	#
	#	# With php-fpm (or other unix sockets):
	#	fastcgi_pass unix:/run/php/php7.4-fpm.sock;
	#	# With php-cgi (or other tcp sockets):
	#	fastcgi_pass 127.0.0.1:9000;
	#}

	# deny access to .htaccess files, if Apache's document root
	# concurs with nginx's one
	#
	#location ~ /\.ht {
	#	deny all;
	#}
}


# Virtual Host configuration for example.com
#
# You can move that to a different file under sites-available/ and symlink that
# to sites-enabled/ to enable it.
#
#server {
#	listen 80;
#	listen [::]:80;
#
#	server_name example.com;
#
#	root /var/www/example.com;
#	index index.html;
#
#	location / {
#		try_files $uri $uri/ =404;
#	}
#}

server {

	# SSL configuration
	#
	# listen 443 ssl default_server;
	# listen [::]:443 ssl default_server;
	#
	# Note: You should disable gzip for SSL traffic.
	# See: https://bugs.debian.org/773332
	#
	# Read up on ssl_ciphers to ensure a secure configuration.
	# See: https://bugs.debian.org/765782
	#
	# Self signed certs generated by the ssl-cert package
	# Don't use them in a production server!
	#
	# include snippets/snakeoil.conf;

	root /var/www/html;

	# Add index.php to the list if you are using PHP
	index index.html index.htm index.nginx-debian.html;
    server_name liaisonspace.com; # managed by Certbot


	location / {
		# First attempt to serve request as file, then
		# as directory, then fall back to displaying a 404.
		try_files $uri $uri/ =404;
	}

	# pass PHP scripts to FastCGI server
	#
	#location ~ \.php$ {
	#	include snippets/fastcgi-php.conf;
	#
	#	# With php-fpm (or other unix sockets):
	#	fastcgi_pass unix:/run/php/php7.4-fpm.sock;
	#	# With php-cgi (or other tcp sockets):
	#	fastcgi_pass 127.0.0.1:9000;
	#}

	# deny access to .htaccess files, if Apache's document root
	# concurs with nginx's one
	#
	#location ~ /\.ht {
	#	deny all;
	#}


    listen 443 ssl; # managed by Certbot
    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/liaisonspace.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/liaisonspace.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}
server {
    if ($host = liaisonspace.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


	listen 80 ;
	listen [::]:80 ;
    server_name liaisonspace.com;
    return 404; # managed by Certbot


}
ubuntu@ip-10-0-2-5:/etc/nginx/sites-enabled$ 



 2839* docker compose -f infra/docker-compose.yml up --build\n
 2840* docker compose -f infra/docker-compose.yml config --quiet\n
 2841* docker compose -f infra/docker-compose.yml up --build\n
 2842* docker compose -f infra/docker-compose.yml config --quiet\n
 2843* docker compose -f infra/docker-compose.yml up --build\n




For normal development testing after code changes:

# frontend checks
cd frontend
npm run lint
npm run build
# backend checks
cd backend
cargo fmt
cargo check
cargo test
To run the full development stack:

docker compose -f infra/docker-compose.dev.yml --env-file infra/.env.development up --build
If the stack is already running and you changed backend/frontend Docker-related code:

docker compose -f infra/docker-compose.dev.yml --env-file infra/.env.development up -d --build backend frontend nginx
If you only changed frontend source and want fast local testing:

cd frontend
npm run dev
If you only changed backend source and want fast local testing:

cd backend
RWAYVE_ENV=development cargo run
Optional workers in development:

docker compose -f infra/docker-compose.dev.yml --env-file infra/.env.development --profile workers up --build




11:57 AM











platform_admin:
  email: maheshiv199@gmail.com
  password: mahesh
organization_admin:
  email: maheshwayve@gmail.com
  password: mahesh
personal:
  email: maheshpy85@gmail.com
  password: mahesh

update users set account_type='platform_admin' where email='maheshiv199@gmail.com';
update users set account_type='organization_admin' where email='maheshwayve@gmail.com';
update users set account_type='personal' where email='maheshpy85@gmail.com';



⚠️ To make it live — required config (not committed)
Set in backend/.env:

STRIPE_SECRET_KEY — sk_...
STRIPE_WEBHOOK_SECRET — whsec_... (point a Stripe webhook endpoint at <host>/billing/webhook)
Without these the module degrades gracefully — checkout returns “Billing is not configured”, the webhook ignores events. Also: the 3 seeded plans have no stripe_price_id — a platform admin must set each one (via POST /api/billing/admin/plans or directly) to a real Stripe Price before checkout works for that plan.

Two deps were added to Cargo.toml: hmac (webhook signatures) and the sqlx json feature (JSONB features column). Nothing is committed — all changes are in your working tree.

One scope note: entitlement resolution is complete (effective_entitlements), but I did not wire enforcement into the email/drive modules — that touches non-billing code and is best done as a deliberate follow-up. Want me to take that next?