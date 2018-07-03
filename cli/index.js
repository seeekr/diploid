#!/usr/bin/env node

require('yargs')
    .command(require('./cmd/init'))
    .command(require('./cmd/log'))
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .parse()
