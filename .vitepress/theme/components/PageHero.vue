<script setup lang="ts">
import { useData } from "vitepress";

const { frontmatter } = useData();
</script>

<template>
  <div v-if="frontmatter.heroImage" class="page-hero">
    <img
      :src="frontmatter.heroImage"
      :alt="frontmatter.heroImageAlt || ''"
      class="page-hero__img"
    />
  </div>
</template>

<style scoped>
.page-hero {
  margin: 0 0 2rem 0;
  border-radius: 12px;
  overflow: hidden;
  line-height: 0;
}

.page-hero__img {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 12px;
}
</style>
