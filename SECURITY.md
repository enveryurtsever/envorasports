# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.
Report them privately using **GitHub Private Vulnerability Reporting** under the **Security** tab.

## Deployment Security Checklist

- Keep `.env` out of version control and use strong random secrets for `SESSION_SECRET` and `JOB_TRIGGER_SECRET`.
- Create administrator accounts with `npm run admin:create` (passwords are stored as scrypt hashes).
- Serve behind HTTPS in production.
