import { useState, useRef } from 'react'
import { useSession } from '../context/SessionContext'
import seoLogo from '../assets/pf-seo-logo.png'
import StatusBar from '../components/StatusBar'

const PACKAGES = [
  {
    name: 'Standard', price: '195', tagline: 'For local and niche businesses that are looking to get started.',
    features: ['25 Target Keywords', '1 Blog Article Per Week', 'On-Page Optimisation', 'High-Quality Backlinks', 'Leading SEO Software', 'Dashboard showing metrics in real time', 'Monthly Loom Video explanation'],
    popular: false,
  },
  {
    name: 'Plus', price: '395', tagline: 'For competitive businesses in a saturated market.',
    features: ['50 Target Keywords', '2 Blog Articles Per Week', 'On-Page Optimisation', 'High-Quality Backlinks', 'Leading SEO Software', 'Dashboard showing metrics in real time', 'Monthly Loom Video explanation'],
    popular: true,
  },
  {
    name: 'Enterprise', price: '595', tagline: 'For businesses that are targeting nationwide or want to scale up.',
    features: ['100 Target Keywords', '4 Blog Articles Per Week', 'On-Page Optimisation', 'High-Quality Backlinks', 'Leading SEO Software', 'Dashboard showing metrics in real time', 'Monthly Loom Video explanation'],
    popular: false,
  },
]

const HIGHLIGHTS = [
  { icon: '✍️', title: 'Content',      desc: 'Engaging blog content, written by humans. Structured for intent and engagement.' },
  { icon: '⚙️', title: 'Optimisation', desc: 'Fully managed optimisation, top to bottom. No keyword saturation or spammy techniques.' },
  { icon: '🔗', title: 'Backlinks',    desc: 'Genuine backlinks via link placements in active content. No spam.' },
  { icon: '📊', title: 'Software',     desc: 'Powered by AgencyAnalytics, SEMRush & Ahrefs. Modern software, all included.' },
]

const INCLUDED = [
  'Google Business Profile Optimisation',
  'Detailed Website Auditing',
  'Technical SEO Optimisation',
  'Google Business Profile Posting',
  'Daily Backlink Tracking',
  'GSC/GA Installation',
  'Blog Publishing Directly onto your Website',
  'Backlink Management',
  'Daily Rank Tracking',
  'Flexible Reporting',
  'Month to month rolling contract.',
]

function Check() {
  return <svg className="w-4 h-4 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="#c9a24b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
}

const inputCls = 'bg-brand-bg border border-brand-border rounded px-3 py-2 font-sans text-sm text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors w-full'

export default function SeoPage() {
  const { session } = useSession()
  const formRef = useRef(null)
  const usernameEmail = /@/.test(session?.username || '') ? session.username : ''

  const [form, setForm]   = useState({ package: '', name: '', email: usernameEmail, company: '', message: '' })
  const [status, setStatus] = useState({ msg: '', type: null })
  const [saving, setSaving] = useState(false)
  const [done, setDone]     = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  function choosePackage(name) {
    set('package', name)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function submit(e) {
    e.preventDefault()
    if (!form.name.trim() || !form.email.trim()) {
      setStatus({ msg: 'Please enter your name and email.', type: 'error' }); return
    }
    setSaving(true); setStatus({ msg: 'Sending your enquiry…', type: 'loading' })
    try {
      const res  = await fetch('/api/seo-interest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to send')
      setDone(true); setStatus({ msg: '', type: null })
    } catch (e) {
      setStatus({ msg: e.message, type: 'error' })
    } finally { setSaving(false) }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center sticky top-0 z-40">
        <div className="font-sans font-bold text-[15px] text-ink">Website SEO</div>
      </header>

      <div className="p-4 sm:p-7 max-w-6xl mx-auto space-y-10">
        {/* Hero */}
        <div className="text-center">
          <img src={seoLogo} alt="Premium Fulfilment SEO" className="h-16 sm:h-20 w-auto mx-auto mb-5" />
          <p className="font-sans text-ink-muted text-base max-w-2xl mx-auto leading-relaxed">
            Premium Fulfilment can help you with your website SEO. These are the three packages that we can offer you.
          </p>
        </div>

        {/* Pricing */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-stretch">
          {PACKAGES.map(p => (
            <div key={p.name}
              className={`relative rounded-2xl border flex flex-col p-6 bg-brand-surface ${p.popular ? 'border-gold shadow-card-hover' : 'border-brand-border'}`}>
              {p.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gold text-white font-mono text-[10px] uppercase tracking-widest px-3 py-1 rounded-full">
                  Most Popular
                </span>
              )}
              <div className="font-sans font-extrabold text-xl text-primary">{p.name}</div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="font-sans font-extrabold text-4xl text-ink">£{p.price}</span>
                <span className="font-mono text-xs text-ink-muted">/ month</span>
              </div>
              <p className="font-sans text-[13px] text-ink-muted mt-2 leading-snug min-h-[40px]">{p.tagline}</p>

              <div className="h-px bg-brand-border my-4" />

              <ul className="space-y-2.5 flex-1">
                {p.features.map(f => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-ink">
                    <Check /><span>{f}</span>
                  </li>
                ))}
              </ul>

              <button onClick={() => choosePackage(p.name)}
                className={`mt-6 block text-center font-sans font-bold text-sm rounded-lg py-2.5 transition-colors ${
                  p.popular ? 'bg-primary hover:bg-primary-hover text-white' : 'border border-primary text-primary hover:bg-primary hover:text-white'
                }`}>
                Register Interest
              </button>
            </div>
          ))}
        </div>

        {/* Every plan includes */}
        <div>
          <h2 className="font-sans font-extrabold text-2xl text-ink text-center mb-6">Every Plan Includes</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {HIGHLIGHTS.map(h => (
              <div key={h.title} className="bg-brand-surface border border-brand-border rounded-xl p-5">
                <div className="text-2xl mb-2">{h.icon}</div>
                <div className="font-sans font-bold text-primary mb-1">{h.title}</div>
                <p className="font-sans text-[13px] text-ink-muted leading-relaxed">{h.desc}</p>
              </div>
            ))}
          </div>

          <div className="bg-brand-surface border border-brand-border rounded-xl p-6">
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5">
              {INCLUDED.map(item => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-ink">
                  <Check /><span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Register interest form */}
        <div ref={formRef} className="bg-primary/5 border border-primary/20 rounded-2xl px-5 sm:px-8 py-8 max-w-2xl mx-auto">
          {done ? (
            <div className="text-center">
              <div className="text-5xl mb-3">✅</div>
              <div className="font-sans font-extrabold text-xl text-ink mb-1">Thanks — enquiry sent</div>
              <p className="font-sans text-sm text-ink-muted">Our team will be in touch shortly to find the right package for your business.</p>
            </div>
          ) : (
            <>
              <div className="text-center mb-5">
                <div className="font-sans font-extrabold text-xl text-ink mb-1">Register Your Interest</div>
                <p className="font-sans text-sm text-ink-muted">Tell us a little about your business and we’ll be in touch.</p>
              </div>
              <form onSubmit={submit} className="space-y-4">
                <StatusBar message={status.msg} type={status.type} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] text-ink-muted uppercase tracking-wide">Package</label>
                    <select className={inputCls} value={form.package} onChange={e => set('package', e.target.value)}>
                      <option value="">No preference yet</option>
                      {PACKAGES.map(p => <option key={p.name} value={p.name}>{p.name} — £{p.price}/mo</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] text-ink-muted uppercase tracking-wide">Your name <span className="text-danger">*</span></label>
                    <input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} placeholder="Jane Doe" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] text-ink-muted uppercase tracking-wide">Email <span className="text-danger">*</span></label>
                    <input className={inputCls} type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="jane@example.com" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] text-ink-muted uppercase tracking-wide">Company / Website</label>
                    <input className={inputCls} value={form.company} onChange={e => set('company', e.target.value)} placeholder="example.com" />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="font-mono text-[10px] text-ink-muted uppercase tracking-wide">Message</label>
                  <textarea className={`${inputCls} min-h-[80px]`} value={form.message} onChange={e => set('message', e.target.value)} placeholder="Anything you’d like us to know…" />
                </div>
                <div className="text-center pt-1">
                  <button type="submit" disabled={saving}
                    className="bg-primary hover:bg-primary-hover text-white font-sans font-bold text-sm rounded-lg px-8 py-3 transition-colors disabled:opacity-50">
                    {saving ? 'Sending…' : 'Register Your Interest'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
