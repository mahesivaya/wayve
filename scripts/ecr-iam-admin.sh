#!/usr/bin/env bash
# One-time IAM setup for the build-images -> ECR pipeline. Run ONCE, as an
# IAM-admin (or root) principal on AWS account 339713009139 — the day-to-day
# `mahesh` IAM user intentionally lacks iam:Create* permissions.
#
# Creates the GitHub OIDC provider + the gha-ecr-push role that GitHub Actions
# (.github/workflows/build-images.yml) assumes to push wayve images to ECR.
# Idempotent: safe to re-run. Everything else is already provisioned — the ECR
# repos, and the GitHub secret AWS_ROLE_ARN + variable AWS_REGION.
set -uo pipefail

ACCOUNT_ID=339713009139
REPO_SLUG=mahesivaya/wayve
ROLE_NAME=gha-ecr-push
OIDC_HOST=token.actions.githubusercontent.com
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"
TMP="$(mktemp -d)"

# Guard: confirm the running identity is really account 339713009139.
CUR=$(aws sts get-caller-identity --query Account --output text)
if [ "$CUR" != "$ACCOUNT_ID" ]; then
  echo "ERROR: current AWS account is $CUR, expected $ACCOUNT_ID. Aborting." >&2
  exit 1
fi

echo "== 1. GitHub OIDC provider =="
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "  [skip] already exists"
else
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_HOST}" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd >/dev/null \
    && echo "  [ok] created"
fi

echo "== 2. IAM role ${ROLE_NAME} (assumable only by ${REPO_SLUG}@main) =="
cat > "$TMP/trust.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "${OIDC_HOST}:aud": "sts.amazonaws.com" },
      "StringLike": { "${OIDC_HOST}:sub": "repo:${REPO_SLUG}:ref:refs/heads/main" }
    }
  }]
}
JSON

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "file://$TMP/trust.json" >/dev/null && echo "  [ok] trust policy updated"
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --description "GitHub Actions OIDC role: push wayve images to ECR" \
    --assume-role-policy-document "file://$TMP/trust.json" >/dev/null && echo "  [ok] role created"
fi

aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser >/dev/null \
  && echo "  [ok] attached AmazonEC2ContainerRegistryPowerUser"

echo
echo "DONE. Role ARN: arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "(This ARN already matches the GitHub secret AWS_ROLE_ARN.)"
rm -rf "$TMP"
