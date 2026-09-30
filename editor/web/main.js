import { createApp } from 'vue';

// The design system loads before the application: tokens first (what a surface, a border and an
// accent are), then the base layer (the shell and the shared components).
import './styles/tokens.css';
import './styles/base.css';

import App from './App.vue';

createApp(App).mount('#app');
