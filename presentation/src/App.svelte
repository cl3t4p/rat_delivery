<script>
  import Overview from './slides/Overview.svelte'
  import Beliefs from './slides/Beliefs.svelte'
  import Deliberation from './slides/Deliberation.svelte'
  import IntentionRevision from './slides/IntentionRevision.svelte'
  import Executor from './slides/Executor.svelte'
  import MultiAgent from './slides/MultiAgent.svelte'
  import LlmIntegration from './slides/LlmIntegration.svelte'
  import Pddl from './slides/Pddl.svelte'

  const slideComponents = [
    { title: 'Overview',            component: Overview },
    { title: 'Beliefs',             component: Beliefs },
    { title: 'Deliberation',        component: Deliberation },
    { title: 'Intention Revision',  component: IntentionRevision },
    { title: 'Executor',            component: Executor },
    { title: 'Multi-agent',         component: MultiAgent },
    { title: 'LLM Integration',     component: LlmIntegration },
    { title: 'PDDL',                component: Pddl },
  ]

  const total = slideComponents.length

  let current = 0
  let exiting = {}
  let navEl

  $: progress = (current / (total - 1)) * 100

  $: if (navEl) {
    const active = navEl.querySelectorAll('button')[current]
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }

  function goTo(n, direction) {
    if (n < 0 || n >= total) return
    const old = current
    exiting = { ...exiting, [old]: direction === 'next' ? 'left' : 'right' }
    setTimeout(() => {
      const copy = { ...exiting }
      delete copy[old]
      exiting = copy
    }, 380)
    current = n
  }

  function handleKey(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') goTo(current + 1, 'next')
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')                    goTo(current - 1, 'prev')
    if (e.key === 'Home')                                                  goTo(0, 'prev')
    if (e.key === 'End')                                                   goTo(total - 1, 'next')
  }
</script>

<svelte:window on:keydown={handleKey} />

<nav bind:this={navEl}>
  <span class="nav-title">rat_delivery</span>
  {#each slideComponents as label, i}
    <button type="button" class:nav-active={i === current} on:click={() => goTo(i, i > current ? 'next' : 'prev')}>{label.title}</button>
  {/each}
</nav>

<button class="arrow-btn" id="btn-prev" disabled={current === 0} on:click={() => goTo(current - 1, 'prev')}>&#8592;</button>
<button class="arrow-btn" id="btn-next" disabled={current === total - 1} on:click={() => goTo(current + 1, 'next')}>&#8594;</button>

<div id="progress-bar" style="width: {progress}%"></div>

<div class="deck">
  {#each slideComponents as SlideComp, i}
    <section
      class="slide"
      class:active={i === current}
      class:exit-left={exiting[i] === 'left'}
      class:exit-right={exiting[i] === 'right'}
    >
      <div class="slide-num">{String(i + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}</div>
      <svelte:component this={SlideComp.component} />
    </section>
  {/each}
</div>
