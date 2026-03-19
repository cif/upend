Guide the user through provisioning AWS infrastructure for their upend stack.

## Prerequisites check

First verify these are installed:
```bash
which aws && aws --version || echo "AWS CLI not found — install: brew install awscli"
which bun || echo "Bun not found — install: curl -fsSL https://bun.sh/install | bash"
```

Check AWS credentials:
```bash
aws sts get-caller-identity 2>&1 || echo "Not authenticated — run: aws configure"
```

If anything is missing, help the user install/configure it before proceeding.

## Provision

Once prerequisites are met, run:
```bash
bunx upend infra:aws
```

This creates:
- **EC2 instance**: t4g.small (ARM), Amazon Linux 2023, 20GB gp3
- **Security group**: ports 22 (SSH), 80 (HTTP), 443 (HTTPS)
- **SSH key pair**: `~/.ssh/upend.pem`
- **SSH config**: `ssh upend` alias
- **Installs on instance**: Bun, Node, Caddy, Claude Code

## After provisioning

1. Set the deploy host:
```bash
bunx upend env:set DEPLOY_HOST ec2-user@<IP_FROM_OUTPUT>
```

2. Deploy:
```bash
bunx upend deploy
```

3. Set up DNS (if using upend.site):
  - Go to https://upend.site/register (coming soon)
  - Or manually point your domain to the instance IP
  - Caddy will handle TLS automatically if using a real domain

4. Register JWKS with Neon (so the Data API validates JWTs):
  - Your JWKS URL is: `https://<your-domain>/.well-known/jwks.json`
  - This needs to be reachable before Neon will accept it

5. Verify:
```bash
bunx upend status
```

## Troubleshooting

If `infra:aws` fails:
- **"key pair already exists"**: The `upend` key pair already exists in AWS. Either use it or delete it: `aws ec2 delete-key-pair --key-name upend`
- **"security group already exists"**: Fine, it will be reused
- **SSH timeout**: Wait a minute for the instance to boot, then try `ssh upend`
- **Setup script fails**: SSH in manually (`ssh upend`) and check what's installed

If `deploy` fails:
- Check `DEPLOY_HOST` is set: `bunx upend env:set DEPLOY_HOST ec2-user@<ip>`
- Check SSH key exists: `ls ~/.ssh/upend.pem`
- Check connectivity: `ssh upend 'echo ok'`
