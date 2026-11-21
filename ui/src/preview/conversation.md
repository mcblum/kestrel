## Next on your list

The release is ready for a final pass. Here’s what remains, in order.

1. **Deploy the verified release.** Use the build currently running in staging. It includes Terraform `58d1a855d`, the worker update, and the latest shared modules.
   - **Watch for this:** a deployment can go green without applying the new infrastructure. Check the pinned revision before continuing.
   - Run both health checks again. They should return **200**, with no retries.

2. **Update the job configuration.** Add `src/main/jobs/production/sync_release_images.groovy` to the seed list, then run the seed with `SEED_TARGET_ENVS=production`.

   Back up the existing configuration first. Keep that backup until the new job has completed successfully.

3. **Run the sync.** Start with a dry run so you can inspect the changes before applying them.
   - First run `DRY_RUN=true`. Expect about 760 images.
   - Then run `DRY_RUN=false`. The job may take a while; the progress log will show each completed batch.

4. **Verify.** Check both access paths:
   - With credentials: confirm the object count and a successful response.
   - Without credentials: download a public image and compare its checksum.

5. **Close the loop.** Wait for the cache to clear, then ask a teammate to retry the upgrade. Record the outcome in the release notes.

The deployment and the sync need your approval. Once those are done, I can check the logs and prepare the follow-up changes.

### Follow-ups that don’t block the release

- Update the staging fixture.
- Remove the two stale jobs.
- Add a regression test for the skipped migration.

> **Ready when you are.** The release is prepared; no production changes have been made.
