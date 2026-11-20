# Privacy policy

This policy covers MIKA5 Community, the desktop application, and the website at mika5.xyz.

## The application

**This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.**

What that means in practice:

- **No telemetry, analytics or crash reporting.** MIKA5 has no account system and sends no usage data to MIKA5 or to anyone else.
- **Your data stays on your computer.** Projects, conversations, settings and the knowledge base are stored in a local SQLite database and in files under the application data folder. Its location per system is listed in the [README](README.md).
- **Local models.** MIKA5 talks to the model runtime on your own machine (Ollama at `127.0.0.1:11434` by default). That traffic does not leave the computer. Ollama is separate software with its own behaviour and policy; a model you run through Ollama's cloud service is handled by Ollama, not locally.
- **Cloud providers are optional and off by default.** OpenAI, Anthropic, Groq, Moonshot and Alibaba Cloud Model Studio are contacted only after you add your own API key and select that provider. Before a request leaves the machine MIKA5 shows what it would include — the message, conversation history, project instructions, attachments, images and knowledge-base fragments — and waits for your consent. What you send is then subject to that provider's terms and privacy policy.
- **API keys** are stored encrypted on your computer and are sent only to the provider they belong to.
- **No automatic updates.** MIKA5 does not download or install anything by itself. It does not check for a new version unless you ask it to or turn that check on.

## The website

- mika5.xyz does not use cookies or analytics. The only thing it stores in your browser is your language choice.
- Pages load a stylesheet tool and fonts from third parties (`cdn.tailwindcss.com` and Google Fonts). Those services receive your IP address and browser details, as with any web request.
- The MIKA5 Pro waitlist form is handled by Buttondown. If you submit it, your email address is sent to Buttondown and used only to tell you when Pro is available. You can unsubscribe from any message.
- Downloads are served by GitHub, under GitHub's own privacy statement.

## Contact

Questions about this policy: **security@mika5.dev**.
