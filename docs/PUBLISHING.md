# Publish XeroLag on GitHub

Repository: [brunothefox/XeroLag](https://github.com/brunothefox/XeroLag). Installation page: [brunothefox.github.io/XeroLag](https://brunothefox.github.io/XeroLag/), once Pages is deployed.

## Enable the page

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open **Actions → Installation page → Run workflow** and select `main`.
4. Wait for the deployment to succeed. The workflow summary contains the live page link.

The workflow uploads only the built website. It never exposes app backups, dependencies or the installer as website source. A push to website files on `main` deploys an update automatically. These steps follow [GitHub's Pages publishing configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Publish the current installer without rebuilding

1. Open **Releases → Draft a new release**.
2. Create tag `v0.3.1` targeting `main` and title it **XeroLag 0.3.1**.
3. Attach both files from the local `dist` folder:
   - `XeroLag-Setup-0.3.1-x64.exe`
   - `XeroLag-Setup-0.3.1-x64.exe.sha256`
4. Copy the relevant release notes from `docs/RELEASE_NOTES.md`. State that this build is unsigned.
5. Choose **Publish release**, with **Set as the latest release** enabled.

The download page detects the latest stable release and connects its download, notes and checksum links automatically. It shows a clear availability message before the first public release. If GitHub's API is unavailable, the links still open GitHub Releases.

Put installers in Releases, not Git commits: the installer exceeds GitHub's [100 MiB repository-file limit](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

## Build future releases on GitHub

1. Update the version in `package.json` and `package-lock.json`, and update the release notes.
2. Commit and push the source changes to `main`.
3. A source/version push starts **Windows release** automatically. You can also select **Actions → Windows release → Run workflow**, or push a matching version tag such as `v0.3.2`.
4. The Windows runner installs locked dependencies, runs checks, builds the custom offline installer, checks its UI with isolated data and creates a **draft** release containing the executable and checksum.
5. Review the draft under **Releases**, then publish it when ready. Published assets are never overwritten by the workflow.

Workflow actions are pinned to verified commits. No personal access token is required; the release job uses GitHub's scoped workflow token. Add signing credentials through GitHub Actions secrets only if you obtain a code-signing certificate; never commit keys or certificates.

## Website development

`npm run site:build` creates `.cache/website`. `npm run test:site` checks the actual page at desktop and mobile sizes, including published, unpublished and unavailable release states. `website/site.config.json` controls the repository and public site URL. The website uses static HTML/CSS/JavaScript, existing XeroLag branding and a real installer screenshot.
