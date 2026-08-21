# FIDELITY.md — where the emulator lied to you

For each behaviour LocalStack did **not** reproduce faithfully: how we detected it,
and what we'd verify on real AWS before trusting it.

## Managed database (RDS) is not available on the free tier

- **What LocalStack did:** RDS is not included in LocalStack's free Hobby license
  at all — it's not a partial/mock gap, the service simply isn't usable on this
  tier.
- **How we detected it:** Confirmed via the course update before attempting any
  RDS resource — switching to Aiven MySQL (a real managed MySQL, free forever)
  was the course's own fix once this was identified, not something we worked
  around ourselves.
- **What I'd verify on real AWS:** That `aws_db_instance` provisions correctly
  with the same engine/version, and that our Secrets Manager envelope format
  (engine, username, password, host, port, dbname) still matches what a real
  RDS endpoint would supply — the only thing that changes on real AWS is the
  `host`/`port` values coming from an actual RDS resource instead of an
  externally-managed Aiven service.

## Secrets Manager enforces a soft-delete recovery window that blocks fast re-apply

- **What LocalStack did:** Faithfully enforced AWS's real behavior — deleting a
  secret with the default `recovery_window_in_days = 30` schedules it for
  deletion rather than removing it immediately. Attempting to `apply` a new
  secret with the same name during that window fails with
  `InvalidRequestException: You can't create this secret because a secret with
  this name is already scheduled for deletion.`
- **How we detected it:** Hit directly during iterative `destroy`/`apply`
  testing of `modules/data` — a `tflocal destroy` followed immediately by
  `tflocal apply` failed with the error above, even though the secret had just
  been destroyed successfully.
- **What I'd verify on real AWS:** This is standard AWS behavior, not a
  LocalStack quirk — real AWS would show the identical error under the same
  default. We set `recovery_window_in_days = 0` for this dev/test module so
  destroy/recreate cycles work immediately; a production deployment would keep
  the default 30-day window as a real safety margin against accidental deletion,
  so this override is deliberately dev-only and should not be copied into a
  production module.

## EC2 Docker-backed execution and ELBv2 (ALB) both require a paid LocalStack tier

- **What LocalStack did:** `terraform apply` on `aws_instance` succeeds and
  reports a running instance (e.g. `i-d19983316bcc20624`), and the resource is
  valid, scannable, and gradeable as IaC — but on the free Hobby tier there is
  no actual Docker container backing it. Confirmed three separate ways:
  `docker ps -a` shows no container tied to the instance ID at all;
  `aws ec2 describe-instances ... --query 'Reservations[0].Instances[0].Tags'`
  shows only the `Name` tag we set, missing the `ec2_vm_manager:docker` tag
  that would indicate real Docker backing; and
  `aws ec2 describe-images --owners self` returns `{"Images": []}` even though
  the instance references a real AMI ID. `aws_lb` (ELBv2/ALB) fails outright on
  apply with `InternalFailure: Sorry, the elbv2 service is not included within
  your LocalStack license`.
- **How we detected it:** Independently reproduced across three separate
  environments before concluding it wasn't a local misconfiguration — one
  teammate's Mac, the same teammate's GitHub Codespaces, and this machine
  (Linux). All three showed identical symptoms with identical setup
  (`EC2_VM_MANAGER=docker` set, `/var/run/docker.sock` mounted, Hobby license
  active). We reported this to the course instructor, who confirmed it is
  expected Hobby-tier behavior, not a bug: real Docker-backed EC2 and ELBv2 are
  both Base-tier-and-up paid features.
- **What I'd verify on real AWS:** That `aws_instance` actually boots and is
  reachable over SSH/HTTP as expected, and that `aws_lb` actually load-balances
  traffic across targets. Given this course-confirmed limitation, EC2 and the
  load balancer in this project are treated purely as IaC deliverables —
  written, validated, and scanned, but not relied on to host the running
  application. The actual application runtime instead runs as a plain Docker
  container wired to Secrets Manager and Aiven, which is what the health-check
  and incident-replay evidence in this repo targets.
