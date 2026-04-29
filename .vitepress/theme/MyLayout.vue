<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import CopyPageButton from "./components/CopyPageButton.vue";
import PageHero from "./components/PageHero.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #doc-before>
      <PageHero />
    </template>
    <template #aside-outline-before>
      <CopyPageButton />
    </template>
  </Layout>
</template>
