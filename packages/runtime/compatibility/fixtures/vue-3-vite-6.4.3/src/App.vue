<script setup>
import { ref } from 'vue';
import './workflow.css';
const framework = 'Vue 3.5.0';
const count = ref(0);
</script>
<template>
  <main class="workflow-card">
    <h1>Vue compatibility claim rendered</h1>
    <p data-framework>{{ framework }}</p>
    <button type="button" data-increment @click="count += 1">Increment</button>
    <p data-count>{{ count }}</p>
  </main>
</template>