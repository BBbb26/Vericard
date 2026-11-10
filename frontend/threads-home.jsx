import { createRoot } from 'react-dom/client';
import Threads from './Threads';

const target = document.getElementById('agentThreads');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
let root;

function update() {
  const active = !motion.matches && !document.getElementById('agentMain').classList.contains('has-chat');
  if (active && !root) {
    root = createRoot(target);
    root.render(<Threads color="#8566ff" lineCount={90} thickness={0.6} softness={1.3}
      amplitude={1.7} distance={0.4} waves={1.05} speed={0.6} split={0.04}
      fray={0.5} angle={9} taper={0.85} brightness={1.4} parting={0}
      enableMouseInteraction={true} fade={0} opacity={1} />);
  } else if (!active && root) {
    root.unmount();
    root = undefined;
  }
}

new MutationObserver(update).observe(document.getElementById('agentMain'), {
  attributes: true, attributeFilter: ['class'],
});
motion.addEventListener('change', update);
update();
