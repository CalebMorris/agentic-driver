# Agentic Driver

A simple browser plugin that connects to a websocket server to allow 2-way communication with an agent that needs to
drive a browser with human handoffs.

## Installing in Brave

1. Open Brave and navigate to `brave://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `plugin/` directory from this repository
5. The Agentic Driver extension will appear in your extensions list — pin it to the toolbar for easy access

> The extension uses Manifest V3, which is supported in Brave 1.19+.

## Example Use Case

I want my agent to investigate and research a topic, but some of the websites present have hard Cloudflare blocks on them. I want the agent to hand off the driving to me with a ping, have me complete the Cloudflare solution, and pass back driver control to the agent.
