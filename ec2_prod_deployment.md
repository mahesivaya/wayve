# rwayve — EC2 Production Deployment

Record of the first production deployment (2026-05-20) and a reproducible
runbook for standing the stack up from scratch or onto a replacement instance.

## Final state

| Item              | Value                                                |
|-------------------|------------------------------------------------------|
| AWS account       | `339713009139`                                       |
| AWS region        | `us-east-1`                                          |
| CLI profile       | `claude_ec2` (alias of IAM user `mahesh`)            |
| EC2 instance      | `i-07af9db286562f5ac` (t3.medium, Ubuntu 24.04 amd64)|
| AMI               | `ami-0fc0d6e8d70ab2d42`                              |
| VPC               | `vpc-0d19dc31c67b2430e` (default, 172.31.0.0/16)     |
| Subnet            | `subnet-0397e79d68d63d189` (us-east-1a)              |
| Security group    | `sg-0390dbee2561df11f` (rwayve-sg)                   |
| Key pair          | `rwayve-deploy` → `~/.ssh/rwayve-deploy.pem`         |
| Elastic IP        | `32.199.117.86` (`eipalloc-03d6c0261fad0146a`)       |
| Hosted zone       | `Z016945635IFJR2D42HYA` (`maheshg.me.`)              |
| App URL           | `http://rwayve.maheshg.me`                           |
| OAuth project     | `brave-idea-477605-h3` (Google Cloud)                |

Stack runs via `docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production up -d --build`
on the EC2. Seven containers: postgres, redis, backend, email_sync_worker,
email_body_worker, frontend, nginx.

## Prerequisites

- AWS CLI v2 on the operator machine.
- An AWS account with an IAM user available for the deploy. We used the existing
  user `mahesh`. **Avoid using the root account** for routine work.
- A domain in Route 53 (we used `maheshg.me`).
- Local clone of the repo at `/Users/<you>/Documents/rwayve` with `gh`/`git` set
  up.

## Step 1 — AWS profile

Add a CLI profile aliased to the IAM user so deploys never accidentally use
the root profile. Run from the operator machine:

```bash
KEY_ID=$(aws configure get aws_access_key_id --profile mahesh)
KEY_SECRET=$(aws configure get aws_secret_access_key --profile mahesh)
aws configure set aws_access_key_id     "$KEY_ID"     --profile claude_ec2
aws configure set aws_secret_access_key "$KEY_SECRET" --profile claude_ec2
aws configure set region                us-east-1     --profile claude_ec2
aws configure set output                json          --profile claude_ec2
unset KEY_ID KEY_SECRET
aws sts get-caller-identity --profile claude_ec2
```

## Step 2 — IAM permissions

The base `mahesh` user had no EC2/Route 53 permissions. Attach AWS-managed
policies from a profile that can manage IAM (we used the root-session profile
`wayve` for this one-time admin action):

```bash
aws iam attach-user-policy --user-name mahesh \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2FullAccess           --profile wayve
aws iam attach-user-policy --user-name mahesh \
  --policy-arn arn:aws:iam::aws:policy/AmazonRoute53FullAccess       --profile wayve
# (Optional, for ECR-based workflows we left attached:)
aws iam attach-user-policy --user-name mahesh \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess --profile wayve
```

IAM changes can take a few seconds to propagate.

## Step 3 — Networking

### 3a. Default VPC

`us-east-1` had no default VPC. Create one (gives 172.31.0.0/16 with public
subnets in every AZ and an IGW):

```bash
aws ec2 create-default-vpc --profile claude_ec2
VPC=$(aws ec2 describe-vpcs --profile claude_ec2 \
  --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
```

### 3b. Key pair

```bash
mkdir -p ~/.ssh
aws ec2 create-key-pair --key-name rwayve-deploy \
  --query 'KeyMaterial' --output text \
  --profile claude_ec2 > ~/.ssh/rwayve-deploy.pem
chmod 600 ~/.ssh/rwayve-deploy.pem
```

The private key cannot be re-downloaded from AWS. **Back it up out of band.**

### 3c. Security group

22 from operator IP only, 80/443 public:

```bash
MY_IP=$(curl -s https://checkip.amazonaws.com)
SG=$(aws ec2 create-security-group \
  --group-name rwayve-sg \
  --description "rwayve deploy: 22 from owner IP, 80/443 public" \
  --vpc-id "$VPC" \
  --profile claude_ec2 --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id "$SG" \
  --protocol tcp --port 22 --cidr "${MY_IP}/32" --profile claude_ec2

aws ec2 authorize-security-group-ingress --group-id "$SG" \
  --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  --profile claude_ec2
```

If the operator's home IP changes, update the SSH rule:

```bash
aws ec2 revoke-security-group-ingress --group-id $SG \
  --protocol tcp --port 22 --cidr "<OLD_IP>/32" --profile claude_ec2
aws ec2 authorize-security-group-ingress --group-id $SG \
  --protocol tcp --port 22 --cidr "<NEW_IP>/32" --profile claude_ec2
```

## Step 4 — Launch the instance

Resolve the current Ubuntu 24.04 amd64 AMI from Canonical's owner ID (we lacked
`ssm:GetParameter` on the public SSM AMI alias):

```bash
AMI=$(aws ec2 describe-images --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" \
    "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate)[-1].ImageId' \
  --output text --profile claude_ec2)
```

User-data installs Docker on first boot (see [user-data script](#user-data-script)
below). Launch:

```bash
SUBNET=$(aws ec2 describe-subnets --profile claude_ec2 \
  --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=us-east-1a \
  --query 'Subnets[0].SubnetId' --output text)

aws ec2 run-instances \
  --image-id "$AMI" \
  --instance-type t3.medium \
  --key-name rwayve-deploy \
  --security-group-ids "$SG" \
  --subnet-id "$SUBNET" \
  --associate-public-ip-address \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
  --user-data file:///tmp/rwayve-user-data.sh \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=rwayve-deploy},{Key=Project,Value=rwayve}]' \
    'ResourceType=volume,Tags=[{Key=Name,Value=rwayve-deploy-root},{Key=Project,Value=rwayve}]' \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --profile claude_ec2

aws ec2 wait instance-running --instance-ids <INSTANCE_ID> --profile claude_ec2
```

`HttpTokens=required` enforces IMDSv2 (mitigates SSRF→credential theft).

### User-data script

`/tmp/rwayve-user-data.sh` — installs Docker CE + Compose plugin and adds
`ubuntu` to the docker group. Idempotent. Writes `/var/log/user-data-complete`
on success and logs to `/var/log/user-data.log`.

```bash
#!/bin/bash
set -e
exec > /var/log/user-data.log 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

usermod -aG docker ubuntu
systemctl enable --now docker
touch /var/log/user-data-complete
```

## Step 5 — Elastic IP + DNS

The auto-assigned public IP changes if the instance is stopped/restarted.
Allocate an Elastic IP and create the A record:

```bash
EIP_JSON=$(aws ec2 allocate-address --domain vpc \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=rwayve-eip},{Key=Project,Value=rwayve}]' \
  --profile claude_ec2)
ALLOC_ID=$(echo "$EIP_JSON" | jq -r .AllocationId)
EIP=$(echo "$EIP_JSON"      | jq -r .PublicIp)

aws ec2 associate-address \
  --instance-id <INSTANCE_ID> \
  --allocation-id "$ALLOC_ID" \
  --profile claude_ec2

ZONE=Z016945635IFJR2D42HYA
cat > /tmp/dns-change.json <<EOF
{
  "Comment": "rwayve app deploy",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "rwayve.maheshg.me.",
      "Type": "A",
      "TTL": 300,
      "ResourceRecords": [{"Value": "$EIP"}]
    }
  }]
}
EOF
aws route53 change-resource-record-sets \
  --hosted-zone-id "$ZONE" \
  --change-batch file:///tmp/dns-change.json \
  --profile claude_ec2
```

## Step 6 — Google OAuth client

The backend bind-mounts `client_secret.json` into the backend container. Set up
a *separate* prod OAuth client (don't reuse dev):

1. https://console.cloud.google.com/apis/credentials → **Create Credentials →
   OAuth client ID → Application type: Web application**.
2. Authorized JavaScript origins:
   - `http://rwayve.maheshg.me`
   - `https://rwayve.maheshg.me` (for after TLS)
3. Authorized redirect URIs:
   - `http://rwayve.maheshg.me/oauth/callback`
   - `https://rwayve.maheshg.me/oauth/callback`
4. Enable APIs: Gmail API, People API, Google Calendar API (if used).
5. Download the JSON, save as `client_secret.json` at the repo root locally,
   then `scp` to the instance (see Step 7).

While the app is in **Testing** mode in the OAuth consent screen, only listed
test users can sign in.

## Step 7 — Bootstrap the instance

Done by `scripts/bootstrap-ec2.sh` (transcribed below). The script clones the
repo, generates fresh per-prod secrets, and writes the three `.env.production`
files plus a stub `client_secret.json` (replaced with the real one in the next
step).

```bash
scp -i ~/.ssh/rwayve-deploy.pem /tmp/rwayve-bootstrap.sh ubuntu@$EIP:/home/ubuntu/bootstrap.sh
ssh -i ~/.ssh/rwayve-deploy.pem ubuntu@$EIP 'bash ~/bootstrap.sh'
```

What it writes (mode 600, never displayed by the operator):

- `~/rwayve/.env.production` — POSTGRES_USER=`rwayve`, POSTGRES_DB=`rwayve_prod`,
  POSTGRES_PASSWORD (24 random hex bytes), POSTGRES_PORT=5432.
- `~/rwayve/backend/.env.production` — full backend config. Notable:
  - `JWT_SECRET` = `openssl rand -hex 64`
  - `AES_KEY` = `openssl rand -hex 32` (interpreted by the backend as Hex64
    input keying material expanded via HKDF-SHA512 — see CLAUDE.md).
  - `AES_HKDF_SALT` = `openssl rand -hex 32`. **Stable forever** once set; losing
    or rotating either of those keys means losing access to encrypted columns.
  - `FRONTEND_URL=http://rwayve.maheshg.me`,
    `BACKEND_URL=http://rwayve.maheshg.me`,
    `GOOGLE_OAUTH_REDIRECT_URI=http://rwayve.maheshg.me/oauth/callback`.
  - `AUTH_COOKIE_SECURE=false` — flip to `true` after HTTPS.
  - Optional integrations left blank: `GEMINI_API_KEY`, `ZOOM_*`, `SMTP_*`.
- `~/rwayve/infra/.env.production` — `CSP_CONNECT_SRC`, `NGINX_HOST=rwayve.maheshg.me`.
- `~/rwayve/client_secret.json` — initially a stub; replaced by the real OAuth
  client JSON next.

### Upload the real client_secret.json

```bash
scp -i ~/.ssh/rwayve-deploy.pem \
  /Users/<you>/Documents/rwayve/client_secret.json \
  ubuntu@rwayve.maheshg.me:/home/ubuntu/rwayve/client_secret.json
ssh -i ~/.ssh/rwayve-deploy.pem ubuntu@rwayve.maheshg.me \
  'chmod 600 /home/ubuntu/rwayve/client_secret.json'
```

The file is bind-mounted, so a swap on the host is picked up by the container
on its next read (backend reads it on startup — restart the backend service
if you replace the file after the stack is up).

## Step 8 — Bring up the stack

The first build takes ~10 minutes (Rust release build on t3.medium). Run it
detached so SSH dropouts don't kill it:

```bash
ssh -i ~/.ssh/rwayve-deploy.pem ubuntu@rwayve.maheshg.me \
  'cd ~/rwayve && nohup docker compose -f infra/docker-compose.prod.yml \
     --env-file infra/.env.production up -d --build > ~/deploy.log 2>&1 &'
```

Poll the log: `tail -f ~/deploy.log` on the instance.

## Step 9 — Verify

```bash
curl -fsS http://rwayve.maheshg.me/api/health    # expect: {"status":"ok"}
open  http://rwayve.maheshg.me/login             # frontend renders
ssh -i ~/.ssh/rwayve-deploy.pem ubuntu@rwayve.maheshg.me \
  'cd ~/rwayve && docker compose -f infra/docker-compose.prod.yml \
     --env-file infra/.env.production ps'
```

Expected: seven containers running, postgres / redis / backend marked
`healthy`.

## Per-deploy workflow

Day-to-day deploys use [`scripts/deploy.sh`](scripts/deploy.sh):

```bash
./scripts/deploy.sh                       # deploy origin/main
BRANCH=feature/foo ./scripts/deploy.sh    # deploy a branch
SKIP_BUILD=1 ./scripts/deploy.sh          # restart only, no rebuild
INSTANCE_HOST=... SSH_KEY=... ./scripts/deploy.sh  # override targets
```

The script: SSH → `git fetch` + hard reset to the chosen branch on the EC2 →
`docker compose up -d --build` against the prod compose file → waits up to 60s
on `/api/health` and prints failure pointer if not healthy.

## Operational notes

- **Cost**: t3.medium on-demand ~$30/mo + 30 GB gp3 ~$2.40/mo + EIP free while
  attached to a running instance.
- **Schema evolution**: `infra/postgres/init.sql` is applied only on a fresh
  postgres volume (`docker-entrypoint-initdb.d`). `ALTER`s against an existing
  prod DB must be run manually — `just db-reset` would wipe prod data, do not
  run it on the EC2 once real data is present.
- **Backups**: nightly `pg_dump` to S3 is **not** set up. Add before relying on
  prod data.
- **Logs**: `docker compose -f infra/docker-compose.prod.yml --env-file
  infra/.env.production logs -f <service>` on the EC2. Backend also writes to
  `backend/logs/dev.log` (mounted into the container).
- **AES_KEY/JWT_SECRET rotation**: AES_KEY rotation = data loss for encrypted
  columns. Both keys live only on the EC2 in `backend/.env.production` —
  **export both and store off-instance** if prod data matters.
- **TLS** (open): not yet configured. Run certbot inside the nginx container
  (or front the host with an ALB), then flip `AUTH_COOKIE_SECURE=true` and
  switch `FRONTEND_URL`, `BACKEND_URL`, and `GOOGLE_OAUTH_REDIRECT_URI` to
  `https://`. Update CSP_CONNECT_SRC accordingly.

## Recovery scenarios

### Restart the stack after instance reboot

```bash
ssh -i ~/.ssh/rwayve-deploy.pem ubuntu@rwayve.maheshg.me \
  'cd ~/rwayve && docker compose -f infra/docker-compose.prod.yml \
     --env-file infra/.env.production up -d'
```

### Replace the EC2 instance (same EIP, same data lost)

1. Stop and terminate the old instance.
2. Re-run Step 4 (Launch) — different instance, same key pair / SG.
3. `aws ec2 associate-address --instance-id <NEW_ID> --allocation-id $ALLOC_ID
   --profile claude_ec2` — moves the EIP, DNS stays correct.
4. Re-run Step 7 (bootstrap). Postgres volume is local to the old instance, so
   data is lost — restore from backup before announcing.

### Lost the SSH key

```bash
aws ec2 delete-key-pair --key-name rwayve-deploy --profile claude_ec2
# Re-create per Step 3b, then either replace the instance (Step 4) or
# update authorized_keys via EC2 Instance Connect / Systems Manager Session
# Manager (requires additional IAM permissions).
```

## Index of artifacts

- `~/.ssh/rwayve-deploy.pem` — SSH private key (local).
- `~/.aws/config` `[profile claude_ec2]` — deploy CLI profile (local).
- `/tmp/rwayve-deploy.env` — provisioning IDs captured during the deploy run.
- `scripts/deploy.sh` — per-deploy script (in repo).
- `infra/docker-compose.prod.yml` — production compose file (in repo).
- `infra/.env.production`, `backend/.env.production`, `.env.production`,
  `client_secret.json` — on the EC2 only, mode 600, not in git.
