#!/usr/bin/env bash
# Option A: give the prod EC2 box keyless ECR-read via an instance role.
# Creates IAM role + instance profile `rwayve-ec2-ecr-read`
# (AmazonEC2ContainerRegistryReadOnly) and associates it to the running
# fluxze instance. Attaching a profile to a running instance is
# non-disruptive (no reboot, no downtime). Idempotent + account-guarded.
#
# Requires (granted to `mahesh` via console inline policy, or run as admin):
#   iam:CreateRole/GetRole/AttachRolePolicy/PassRole,
#   iam:CreateInstanceProfile/GetInstanceProfile/AddRoleToInstanceProfile,
#   ec2:AssociateIamInstanceProfile, ec2:DescribeIamInstanceProfileAssociations
set -uo pipefail

ACCOUNT_ID=339713009139
REGION=us-east-1
NAME=rwayve-ec2-ecr-read          # used for both the role and the instance profile
INSTANCE_ID=i-07af9db286562f5ac    # fluxze.com
TMP="$(mktemp -d)"

CUR=$(aws sts get-caller-identity --query Account --output text)
if [ "$CUR" != "$ACCOUNT_ID" ]; then
  echo "ERROR: current AWS account is $CUR, expected $ACCOUNT_ID. Aborting." >&2
  exit 1
fi

echo "== 1. IAM role ${NAME} (EC2 trust + ECR read-only) =="
cat > "$TMP/ec2-trust.json" <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
"Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
if aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
  echo "  [skip] role exists"
else
  aws iam create-role --role-name "$NAME" \
    --description "rwayve prod EC2: pull images from ECR" \
    --assume-role-policy-document "file://$TMP/ec2-trust.json" >/dev/null && echo "  [ok] role created"
fi
aws iam attach-role-policy --role-name "$NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly >/dev/null \
  && echo "  [ok] attached AmazonEC2ContainerRegistryReadOnly"

echo "== 2. Instance profile ${NAME} =="
if aws iam get-instance-profile --instance-profile-name "$NAME" >/dev/null 2>&1; then
  echo "  [skip] instance profile exists"
else
  aws iam create-instance-profile --instance-profile-name "$NAME" >/dev/null && echo "  [ok] created"
fi
# Add the role to the profile (harmless if already present).
aws iam add-role-to-instance-profile --instance-profile-name "$NAME" --role-name "$NAME" 2>/dev/null \
  && echo "  [ok] role added to profile" || echo "  [skip] role already in profile"

echo "== 3. Associate profile with ${INSTANCE_ID} =="
EXISTING=$(aws ec2 describe-iam-instance-profile-associations --region "$REGION" \
  --filters "Name=instance-id,Values=$INSTANCE_ID" \
  --query 'IamInstanceProfileAssociations[?State==`associated`].IamInstanceProfile.Arn' \
  --output text 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "  [skip] already associated: $EXISTING"
else
  # Newly-created instance profiles take a few seconds to propagate to EC2;
  # retry the associate a handful of times before giving up.
  ok=0
  for _ in 1 2 3 4 5 6; do
    if aws ec2 associate-iam-instance-profile --region "$REGION" \
        --instance-id "$INSTANCE_ID" --iam-instance-profile "Name=$NAME" >/dev/null 2>&1; then
      ok=1; echo "  [ok] associated"; break
    fi
  done
  if [ "$ok" != "1" ]; then
    echo "  [warn] associate not yet succeeded (profile still propagating)." >&2
    echo "         Re-run this script in ~15s — steps 1-2 will skip, only the" >&2
    echo "         associate retries." >&2
  fi
fi

echo
echo "DONE. Instance role: arn:aws:iam::${ACCOUNT_ID}:role/${NAME}"
rm -rf "$TMP"
