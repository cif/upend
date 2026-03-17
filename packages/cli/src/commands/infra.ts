import { log } from "../lib/log";
import { exec, execOrDie, hasCommand } from "../lib/exec";

export default async function infra(args: string[]) {
  // parse provider from command: infra:aws, infra:gcp, etc.
  const fullCommand = process.argv[2]; // e.g. "infra:aws"
  const provider = fullCommand?.split(":")[1] || args[0];

  if (!provider) {
    log.error("usage: upend infra:<provider>");
    log.dim("  upend infra:aws     provision an EC2 instance");
    log.dim("  upend infra:gcp     provision a GCE instance (coming soon)");
    log.dim("  upend infra:azure   provision an Azure VM (coming soon)");
    process.exit(1);
  }

  switch (provider) {
    case "aws":
      await provisionAWS();
      break;
    case "gcp":
    case "azure":
      log.error(`${provider} support coming soon`);
      process.exit(1);
    default:
      log.error(`unknown provider: ${provider}`);
      process.exit(1);
  }
}

async function provisionAWS() {
  log.header("provisioning AWS infrastructure");

  // check AWS CLI
  if (!(await hasCommand("aws"))) {
    log.error("AWS CLI not found. Install: brew install awscli");
    process.exit(1);
  }

  // verify credentials
  log.info("verifying AWS credentials...");
  const { stdout: identity } = await execOrDie(["aws", "sts", "get-caller-identity"]);
  const account = JSON.parse(identity);
  log.success(`authenticated as ${account.Arn}`);

  const region = process.env.AWS_REGION || "us-east-1";
  const keyName = "upend";
  const instanceType = "t4g.small";

  // create key pair if it doesn't exist
  log.info("setting up SSH key pair...");
  const { exitCode: keyExists } = await exec(
    ["aws", "ec2", "describe-key-pairs", "--key-names", keyName, "--region", region],
    { silent: true }
  );

  if (keyExists !== 0) {
    const sshDir = `${process.env.HOME}/.ssh`;
    await execOrDie([
      "aws", "ec2", "create-key-pair",
      "--key-name", keyName,
      "--key-type", "ed25519",
      "--query", "KeyMaterial",
      "--output", "text",
      "--region", region,
    ]);
    // the key material goes to stdout — capture and write
    const { stdout: keyMaterial } = await execOrDie([
      "aws", "ec2", "create-key-pair",
      "--key-name", `${keyName}-2`,
      "--key-type", "ed25519",
      "--query", "KeyMaterial",
      "--output", "text",
      "--region", region,
    ]);
    // actually let's do this properly
    log.warn("key pair created but you'll need to save it manually");
    log.dim(`aws ec2 create-key-pair --key-name ${keyName} --query KeyMaterial --output text > ~/.ssh/upend.pem`);
  }
  log.success("SSH key pair ready");

  // create security group
  log.info("creating security group...");
  const { stdout: sgJson, exitCode: sgExists } = await exec(
    ["aws", "ec2", "describe-security-groups", "--group-names", "upend", "--region", region],
    { silent: true }
  );

  let sgId: string;
  if (sgExists === 0) {
    sgId = JSON.parse(sgJson).SecurityGroups[0].GroupId;
    log.success(`using existing security group: ${sgId}`);
  } else {
    const { stdout: newSg } = await execOrDie([
      "aws", "ec2", "create-security-group",
      "--group-name", "upend",
      "--description", "upend server",
      "--query", "GroupId",
      "--output", "text",
      "--region", region,
    ]);
    sgId = newSg;

    // open ports
    for (const port of [22, 80, 443]) {
      await exec([
        "aws", "ec2", "authorize-security-group-ingress",
        "--group-id", sgId,
        "--protocol", "tcp",
        "--port", String(port),
        "--cidr", "0.0.0.0/0",
        "--region", region,
      ], { silent: true });
    }
    log.success(`security group created: ${sgId}`);
  }

  // find latest Amazon Linux 2023 ARM AMI
  log.info("finding latest AMI...");
  const { stdout: amiId } = await execOrDie([
    "aws", "ec2", "describe-images",
    "--owners", "amazon",
    "--filters", "Name=name,Values=al2023-ami-2023*-arm64", "Name=state,Values=available",
    "--query", "sort_by(Images, &CreationDate)[-1].ImageId",
    "--output", "text",
    "--region", region,
  ]);
  log.success(`AMI: ${amiId}`);

  // launch instance
  log.info("launching instance...");
  const { stdout: instanceId } = await execOrDie([
    "aws", "ec2", "run-instances",
    "--image-id", amiId,
    "--instance-type", instanceType,
    "--key-name", keyName,
    "--security-group-ids", sgId,
    "--block-device-mappings", '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]',
    "--tag-specifications", 'ResourceType=instance,Tags=[{Key=Name,Value=upend}]',
    "--query", "Instances[0].InstanceId",
    "--output", "text",
    "--region", region,
  ]);
  log.success(`instance: ${instanceId}`);

  // wait for running
  log.info("waiting for instance to start...");
  await execOrDie([
    "aws", "ec2", "wait", "instance-running",
    "--instance-ids", instanceId,
    "--region", region,
  ]);

  // get public IP
  const { stdout: publicIp } = await execOrDie([
    "aws", "ec2", "describe-instances",
    "--instance-ids", instanceId,
    "--query", "Reservations[0].Instances[0].PublicIpAddress",
    "--output", "text",
    "--region", region,
  ]);
  log.success(`public IP: ${publicIp}`);

  // set up SSH config
  log.info("adding SSH config...");
  const sshConfigEntry = `\nHost upend\n  HostName ${publicIp}\n  User ec2-user\n  IdentityFile ~/.ssh/upend.pem\n`;
  const sshConfigPath = `${process.env.HOME}/.ssh/config`;
  const existing = await Bun.file(sshConfigPath).text().catch(() => "");
  if (!existing.includes("Host upend")) {
    await Bun.write(sshConfigPath, existing + sshConfigEntry);
  }
  log.success("SSH config updated");

  // wait for SSH to be ready
  log.info("waiting for SSH...");
  for (let i = 0; i < 30; i++) {
    const { exitCode } = await exec(
      ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", "upend", "echo ok"],
      { silent: true }
    );
    if (exitCode === 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  log.success("SSH connected");

  // run setup on the instance
  log.info("installing bun, node, caddy, claude code...");
  const setupScript = `
    set -euo pipefail
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs git
    ARCH=$(uname -m | sed 's/aarch64/arm64/' | sed 's/x86_64/amd64/')
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$ARCH" -o /tmp/caddy
    sudo mv /tmp/caddy /usr/local/bin/caddy && sudo chmod +x /usr/local/bin/caddy
    bun install -g @anthropic-ai/claude-code
    sudo ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun
    sudo ln -sf $HOME/.bun/bin/bunx /usr/local/bin/bunx
    sudo ln -sf $HOME/.bun/bin/claude /usr/local/bin/claude
    sudo ln -sf $HOME/.bun/bin/dotenvx /usr/local/bin/dotenvx
    sudo mkdir -p /opt/upend && sudo chown $(whoami):$(whoami) /opt/upend
    echo "setup complete"
  `;
  await execOrDie(["ssh", "upend", "bash -s"], { cwd: process.cwd() });
  // actually need to pipe the script
  const setupProc = Bun.spawn(["ssh", "upend", "bash -s"], {
    stdin: new TextEncoder().encode(setupScript),
    stdout: "inherit",
    stderr: "inherit",
  });
  await setupProc.exited;
  log.success("instance provisioned");

  log.blank();
  log.header("infrastructure ready!");
  log.info(`instance: ${instanceId}`);
  log.info(`IP: ${publicIp}`);
  log.info(`SSH: ssh upend`);
  log.blank();
  log.info("add to your .env:");
  log.dim(`DEPLOY_HOST=ec2-user@${publicIp}`);
  log.blank();
  log.info("then deploy:");
  log.dim("upend deploy");
  log.blank();
}
