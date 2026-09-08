# Security

Never commit production `.env` files, SDK secrets, cloud/SSH credentials,
device registries, OpenIDs, session tokens, databases or personal camera media.
Use your own isolated test credentials and keep production secrets server-side.

The export was checked with Gitleaks and known local credential matching before
publication; this is not a guarantee that the application has no vulnerabilities.
Report security issues privately to the repository owner, without including
real user data or usable credentials in public issues.
