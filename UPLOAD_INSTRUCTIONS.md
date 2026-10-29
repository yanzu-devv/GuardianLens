# Upload GuardianLens to GitHub

This folder is the complete source-code upload package. You do not need to install Node.js, Python, or Twilio on the computer used only to upload it.

## Transfer

1. Zip the entire `GuardianLens.github` folder, including hidden files.
2. Transfer the ZIP to your GitHub computer and extract it.
3. Upload the extracted contents, not the ZIP file itself.

## Upload in your browser

1. Sign in to GitHub and open https://github.com/new.
2. Name the repository `GuardianLens`. Choose its visibility according to the hackathon requirements.
3. Leave the README, .gitignore, and license initialization options unchecked. Click Create repository.
4. Click “uploading an existing file” (or Add file → Upload files).
5. Drag the contents of this extracted folder into the upload area. README.md, app/, and python-detector/ should appear at the repository root.
6. Include hidden files, especially `.gitignore`, `app/.gitignore`, and `app/.env.example`. On Mac, Command + Shift + Period shows hidden files in Finder. On Windows, enable View → Show → Hidden items.
7. Enter `Initial GuardianLens submission` as the commit message, then commit the files.
8. Copy the repository URL and paste it into Devpost’s Project details → “Try it out” links.

## Included and excluded

Included: app source, tests, browser assets, Electron source, package lockfile, model/runtime download script, Python prototype, setup guides, and blank environment template.

Excluded: private Twilio credentials, personal incident/location history, installed dependencies, downloaded model/runtime binaries, build output, caches, and old ZIP archives. Setup instructions in README.md restore the required dependencies and model assets when running the project.

Keep the separate `GuardianLens.submit` private backup out of GitHub. Do not upload the entire yz folder.
