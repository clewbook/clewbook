# Deploying the static demo to Vercel (internal, never published; nothing here has been run)

What you upload: only the folder `runs/vercel-site` (about 8 MB, 172 files): the example pages, the browser modules, fonts, the example campaigns as plain files, and `vercel.json`. No wallet, no key, no program, no logs. It reads only the public test-network servers. Nothing is deployed until you run step 6.

You need: a Vercel account (you have one), Node.js on this machine (`node -v` should print 18 or higher; it does here), and about 15 minutes.

1. **Install the Vercel command line tool.** In a terminal: `npm install -g vercel`. If it says "permission denied", do not use sudo: instead run it without installing, as `npx vercel` in every command below where it says `vercel`. Check: `vercel --version` prints a version number.
2. **Log in.** `vercel login`. Choose how to log in (email is simplest). It opens a browser page or sends a link by email; confirm there. The terminal then says "Success". Check: `vercel whoami` prints your account name.
3. **Build the folder and check it before uploading.** From the project folder:
   `./app/web/make-vercel.sh` (builds `runs/vercel-site`), then `./app/web/check-vercel.sh` (the last line must be `ALL PASS`: no names, ids, keys or local paths inside; headers right; no tracking). If the browser modules are old, run `app/web/build.sh` first and then these two.
4. **Go into the folder.** `cd runs/vercel-site`
5. **Create the project and name it.** `vercel link`. Answer: set up and link? **Y**; which scope? your own account; link to an existing project? **N**; project name: type the name you want (it becomes `<name>.vercel.app`); code directory: just press Enter (`./`). If it offers to change build settings: say **no** (there is no build; the folder is uploaded as it is).
6. **Deploy.** `vercel deploy --prod`. When it finishes it prints the **Production** address (`https://<name>.vercel.app`) and an "Inspect" link. That printed address is the public address. (`vercel ls` lists deployments later.)
7. **Make sure it is public.** Open the address in a private browser window (not logged in). If it asks you to log in to Vercel, open the project's page at vercel.com, Settings, Deployment Protection, and turn the protection off for production, then try again. Do not turn on Web Analytics or Speed Insights anywhere in the project: the demo is built to need neither.
8. **Check the deployed copy with the same checks as locally.** Go back to the project folder (`cd` out of `runs/vercel-site`). Then:
   `BASE_URL=https://<name>.vercel.app node app/web/static-e2e.cjs` (it needs the browser libraries on this machine; ask me to run it if it complains about a missing library). It must end with no line starting with FAIL. It prints, among others, `/pkg/ll_web_bg.wasm loads (HTTP 200 ...) as application/wasm` and the same for `/proof/ll_proofcheck_bg.wasm`, the security-headers line, then the recount of every example (the failing example must show its R9 failure on purpose).
9. **Confirm the .wasm files by hand too.** `curl -sI https://<name>.vercel.app/pkg/ll_web_bg.wasm` must show `HTTP/2 200` and `content-type: application/wasm`; the same for `/proof/ll_proofcheck_bg.wasm`. Then open `https://<name>.vercel.app/` in a browser, click the first example's recount: it must reach "All checks pass" in about a minute.
10. **Roll back / take it down.**
    * Go back to the previous version: `vercel ls` (find the earlier deployment), then `vercel rollback <that address or id>`; check with step 9.
    * Take the site offline completely: `vercel remove <name> --yes` (deletes the project and all its deployments). The site stops working at once; nothing else is affected.

What I could not verify (I have no Vercel account here and did not deploy): that your Vercel plan accepts the settings in `vercel.json` as written (the headers, the content-type for the two `.wasm` files, and the rewrite that serves each campaign's `index.html` at the address without a trailing slash); that the content security policy does not block anything on the real host (it was tested only against a local stand-in server that applies the same rules, and every page worked); the exact wording of the prompts in steps 2 and 5; whether the rollback command is available on your plan. If step 8 or 9 fails, send me the output and the deployed address; do not change settings by guessing.

Notes: Vercel logs visitors' addresses on its side, which cannot be switched off. The demo pages themselves send nothing to anyone but the public test-network servers named in the page. The two example "relays" are two copies of the same files, a demonstration and not independent evidence.
