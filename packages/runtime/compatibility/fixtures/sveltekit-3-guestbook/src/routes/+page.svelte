<script>
  import { enhance } from '$app/forms';

  let { data, form } = $props();
</script>

<svelte:head>
  <title>Guestbook</title>
</svelte:head>

<h1>Guestbook</h1>

<ul>
  {#each data.entries as entry (entry.id)}
    <li><strong>{entry.name}</strong>: {entry.message}</li>
  {/each}
</ul>

<form method="POST" use:enhance>
  <input name="name" placeholder="Your name" />
  <input name="message" placeholder="Say something" />
  <button>Sign</button>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
</form>
