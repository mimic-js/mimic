<script setup lang="ts">
const { data: greeting } = await useFetch('/api/greeting');
const count = ref(0);
</script>

<template>
  <main>
    <h1>{{ greeting?.message }}</h1>
    <button type="button" @click="count++">Clicked {{ count }} times</button>
  </main>
</template>
