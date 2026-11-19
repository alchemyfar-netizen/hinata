<script setup lang="ts">
import { RouterLink } from 'vue-router'

// Hinata's logo, served from the web app's public folder.
const hinataLogo = `${import.meta.env.BASE_URL}favicon.svg`
</script>

<template>
  <RouterLink
    to="/" flex="~"
    w-max items-center gap-2 px-2 text-nowrap text-2xl outline-none
  >
    <img :src="hinataLogo" alt="" h-8 w-8 rounded-lg>
    <div translate-y="[2px]" font-quicksand font-semibold>
      <span>Hinata</span>
    </div>
  </RouterLink>
</template>

<style scoped>
.theme-colored {
  filter: hue-rotate(calc(var(--chromatic-hue, 0) * 1deg));
}
</style>
