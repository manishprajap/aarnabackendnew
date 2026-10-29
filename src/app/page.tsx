import Image from "next/image";

const capabilities = [
  {
    number: "01",
    title: "Create content",
    description:
      "Turn product photos and business details into ready-to-publish marketing creatives.",
    icon: "✳",
    tone: "mint",
  },
  {
    number: "02",
    title: "Manage channels",
    description:
      "Bring WhatsApp conversations, campaigns, and social connections into one workspace.",
    icon: "↗",
    tone: "peach",
  },
  {
    number: "03",
    title: "Grow with insight",
    description:
      "Plan a consistent marketing calendar and understand how your content performs.",
    icon: "⌁",
    tone: "lavender",
  },
];

const platforms = [
  {
    name: "Instagram",
    category: "SOCIAL CONTENT",
    description: "Plan and share branded posts, reels, and stories.",
    symbol: "◎",
    tone: "instagram",
  },
  {
    name: "Facebook",
    category: "SOCIAL CONTENT",
    description: "Manage your Facebook presence and page campaigns.",
    symbol: "f",
    tone: "facebook",
  },
  {
    name: "LinkedIn",
    category: "PROFESSIONAL NETWORK",
    description: "Share business updates with your professional network.",
    symbol: "in",
    tone: "linkedin",
  },
  {
    name: "Google Business Profile",
    category: "LOCAL PRESENCE",
    description: "Connect your business listing and manage its profile.",
    symbol: "G",
    tone: "google",
  },
  {
    name: "YouTube",
    category: "VIDEO",
    description: "Connect your channel and follow video performance insights.",
    symbol: "▶",
    tone: "youtube",
  },
  {
    name: "WhatsApp Business",
    category: "CUSTOMER MESSAGING",
    description: "Handle customer chats, catalogs, campaigns, and AI replies.",
    symbol: "◔",
    tone: "whatsapp",
  },
];

const workflow = [
  ["Connect", "Link your business accounts and WhatsApp number."],
  ["Create", "Build on-brand content and campaigns with AI."],
  ["Engage", "Keep customer conversations moving from one inbox."],
];

export default function Home() {
  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="#" aria-label="Aarnex AI home">
          <Image
            className="brand-logo"
            src="/aarnexai-backend/aarna-logo.png"
            alt="Aarnex AI — Connect, Automate, Grow"
            width={300}
            height={92}
            unoptimized
            priority
          />
        </a>
        <nav className="site-nav" aria-label="Main navigation">
          <a href="#platform">Platform</a>
          <a href="#channels">Channels</a>
          <a href="#workflow">How it works</a>
          <a className="nav-cta" href="#whatsapp">
            WhatsApp AI <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>

      <section className="hero" id="platform">
        <div className="hero-copy">
          <span className="eyebrow"><span /> YOUR BUSINESS, IN MOTION</span>
          <h1>
            Make your next
            <br />
            move <em>smarter.</em>
          </h1>
          <p>
            Create better marketing, manage customer conversations, and grow
            your business — all from one AI-powered workspace.
          </p>
          <div className="hero-actions">
            <a className="button button-dark" href="#workflow">
              Explore the workspace <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href="#whatsapp">
              Meet your AI assistant <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className="hero-note">
            <span className="note-avatars" aria-hidden="true">
              <i>A</i><i>✳</i><i>W</i>
            </span>
            <span>One workspace for your everyday growth</span>
          </div>
        </div>

        <div className="hero-art" aria-label="Aarnex AI workspace preview">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-sun">a<span>✳</span></div>
          <div className="float-card float-card-top">
            <span className="float-icon float-icon-green">✳</span>
            <span><b>Ideas, meet action</b><small>AI-powered creation</small></span>
          </div>
          <div className="preview-window">
            <div className="preview-top">
              <span className="preview-brand"><i>a</i> aarnex</span>
              <span className="preview-menu"><i /><i /><i /></span>
            </div>
            <div className="preview-greeting">
              <small>YOUR BUSINESS, AT A GLANCE</small>
              <h2>Good morning<span>.</span></h2>
              <p>Let’s make something great for your business.</p>
            </div>
            <div className="preview-feature">
              <div className="preview-feature-copy">
                <span>YOUR NEXT BIG IDEA</span>
                <b>Show the world<br />what you do.</b>
                <i>MAKE A POST <span>↗</span></i>
              </div>
              <div className="preview-flower"><span>✿</span></div>
            </div>
            <div className="preview-bottom">
              <span><i className="bottom-dot" /> Create</span>
              <span><i className="bottom-chat">◌</i> Connect</span>
              <span><i className="bottom-chart">⌁</i> Grow</span>
            </div>
          </div>
          <div className="float-card float-card-bottom">
            <span className="float-icon float-icon-peach">◌</span>
            <span><b>Always in the loop</b><small>WhatsApp, made easier</small></span>
            <span className="online-dot" />
          </div>
          <span className="art-caption">A LITTLE MORE HUMAN. A LOT MORE POSSIBLE.</span>
        </div>
      </section>

      <section className="capabilities" aria-labelledby="capabilities-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">A BETTER WAY TO GROW</span>
            <h2 id="capabilities-title">Everything works better, <em>together.</em></h2>
          </div>
          <p>Less switching between tools. More time for the work that matters.</p>
        </div>
        <div className="capability-grid">
          {capabilities.map((item) => (
            <article className="capability-card" key={item.number}>
              <div className="capability-card-top">
                <span className={`capability-icon ${item.tone}`}>{item.icon}</span>
                <span className="card-number">{item.number}</span>
              </div>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <span className="card-arrow" aria-hidden="true">↗</span>
            </article>
          ))}
        </div>
      </section>

      <section className="platforms-section" id="channels" aria-labelledby="platforms-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">YOUR CHANNELS, IN ONE PLACE</span>
            <h2 id="platforms-title">Show up where <em>your people are.</em></h2>
          </div>
          <p>Connect the platforms you already use and manage your business from one workspace.</p>
        </div>
        <div className="platform-grid">
          {platforms.map((platform) => (
            <article className="platform-card" key={platform.name}>
              <div className="platform-card-top">
                <span className={`platform-logo ${platform.tone}`} aria-hidden="true">
                  {platform.symbol}
                </span>
                <span className="platform-category">{platform.category}</span>
              </div>
              <h3>{platform.name}</h3>
              <p>{platform.description}</p>
            </article>
          ))}
        </div>
        <p className="platforms-footnote">
          Available features depend on each platform connection and its permissions.
        </p>
      </section>

      <section className="whatsapp-section" id="whatsapp">
        <div className="whatsapp-copy">
          <span className="eyebrow light-eyebrow"><span /> A MORE HELPFUL INBOX</span>
          <h2>Your WhatsApp,<br />with a little <em>more intelligence.</em></h2>
          <p>
            Connect your WhatsApp Business number and let an AI assistant help
            answer incoming text messages. You stay in control — switch it on
            when you’re ready, and update its business instructions any time.
          </p>
          <ul className="whatsapp-points">
            <li><span>✓</span> Replies powered by your server-side Gemini key</li>
            <li><span>✓</span> Automatic replies are off until you opt in</li>
            <li><span>✓</span> Media messages stay in your regular inbox</li>
          </ul>
          <a className="button button-light" href="#workflow">
            See how it works <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="chat-card" aria-label="Illustration of an AI-assisted WhatsApp conversation">
          <div className="chat-card-header">
            <span className="chat-avatar">M</span>
            <span><b>Customer conversation</b><small><i /> AI assistant ready</small></span>
            <span className="chat-menu">···</span>
          </div>
          <div className="chat-day">TODAY</div>
          <div className="chat-message customer-message">
            Hi! Do you have a good time for a consultation this week?
            <small>10:42 AM</small>
          </div>
          <div className="chat-message ai-message">
            <span className="ai-label">✳ AARNA AI</span>
            Hello! I can help with that. What day works best for you?
            <small>10:42 AM <span>✓✓</span></small>
          </div>
          <div className="chat-input-preview">
            <span>Write a message…</span><i>↑</i>
          </div>
          <div className="chat-footnote"><span>✳</span> Replies can be reviewed in your WhatsApp inbox.</div>
        </div>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="workflow-heading">
          <span className="eyebrow">SIMPLE BY DESIGN</span>
          <h2>From first hello<br />to <em>what’s next.</em></h2>
          <p>Bring your everyday business workflow into one place.</p>
        </div>
        <div className="workflow-steps">
          {workflow.map(([title, description], index) => (
            <article className="workflow-step" key={title}>
              <span className="step-number">0{index + 1}</span>
              <div className="step-line"><i /></div>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="site-footer">
        <a className="brand footer-brand" href="#" aria-label="Aarnex AI home">
          <Image
            className="brand-logo"
            src="/aarnexai-backend/aarna-logo.png"
            alt="Aarnex AI — Connect, Automate, Grow"
            width={240}
            height={74}
            unoptimized
          />
        </a>
        <span>Thoughtful tools for ambitious businesses.</span>
        <a href="#platform">Back to top ↑</a>
      </footer>
    </main>
  );
}
