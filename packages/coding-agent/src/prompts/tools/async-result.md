<system-notice>
{{#if multiple}}{{jobs.length}} background jobs have settled. Resume your work using the bash, task, or SSH transfer results below.

{{else}}Background job {{jobs.[0].jobId}} has settled. Resume your work using the result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}} ──
{{/if}}{{this.result}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
