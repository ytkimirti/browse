# Upstash console on a Box

Use this for the console's authenticated local or A/B review. Read `browse box
help` for transfer and process commands. Keep orchestration in a shell script
outside the browse CLI so both comparison builds use the same setup.

1. Package the requested source revisions and required assets. Exclude dependency
   directories, build caches, unrelated recordings and unused public datasets.
   Disable macOS archive metadata when making a tarball. Include deleted files in
   the comparison plan: copying changed files over a warm tree leaves old routes.
2. Read the project's packageManager and lockfile. Install that package-manager
   version into a writable prefix on the Box and use its absolute executable in
   later commands. Preserve the lockfile; changing installer to bypass an error
   can change the dependency graph. Supply a Git repository when a prepare hook
   requires one. For two revisions, install each locked dependency graph or share
   only when the dependency inputs match.
3. Copy the intended environment privately. Check that the Clerk instance,
   token issuer and backend all refer to the same environment. An expired
   development token or accidental keyless instance can defeat valid cookies.
   Compare identifiers or hashes when diagnosing; keep secrets out of logs.
4. Start the app through the Box exec API with a detached process and a log.
   Probe its actual route with a deadline, inspecting the log if readiness fails.
   Use the localhost origin expected by the development auth configuration.
5. Confirm authentication and a real resource in both builds before collecting
   matched screenshots. Apply any setup prerequisite equally to both builds and
   name it in the comparison so the images isolate the requested change.

For satellite previews, first visit console.upstash.com with the saved profile,
confirm the primary session, then refresh the preview. Follow the preview's own
primary-domain sign-in instruction instead of repeatedly starting Google there.

When a task needs a human passkey, expose that step promptly. Fixture screenshots
can support implementation work while waiting; they do not complete requested
coverage of the real console.
